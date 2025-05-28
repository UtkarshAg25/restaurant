// consumer.js - Order Processing Worker
const amqp = require('amqplib');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

class OrderProcessor {
  constructor(workerId = null) {
    this.workerId = workerId || `worker-${uuidv4().slice(0, 8)}`;
    this.connection = null;
    this.channel = null;
    this.processing = false;
    
    // Queue configuration
    this.QUEUE_NAME = 'restaurant_orders';
    this.EXCHANGE_NAME = 'restaurant_exchange';
    this.DLQ_NAME = 'restaurant_orders_dlq';
    this.RETRY_EXCHANGE = 'restaurant_retry_exchange';
    
    // Processing configuration
    this.MAX_RETRIES = 3;
    this.BASE_DELAY = 1000; // 1 second base delay for exponential backoff
    this.PROCESSING_TIMES = {
      'Preparing': 3000,    // 3 seconds to simulate cooking
      'Ready for Pickup': 2000, // 2 seconds to package
      'Completed': 1000     // 1 second to mark complete
    };
    
    // Server URL for status updates
    this.SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
  }

  async connect() {
    try {
      this.connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
      this.channel = await this.connection.createChannel();
      
      // Set prefetch to 1 for fair dispatching
      await this.channel.prefetch(1);
      
      console.log(`${this.workerId} connected to RabbitMQ`);
    } catch (error) {
      console.error(`${this.workerId} failed to connect:`, error);
      throw error;
    }
  }

  async startProcessing() {
    try {
      this.processing = true;
      console.log(`${this.workerId} starting to process orders...`);
      
      await this.channel.consume(this.QUEUE_NAME, async (msg) => {
        if (msg) {
          await this.processMessage(msg);
        }
      }, { noAck: false });
      
    } catch (error) {
      console.error(`${this.workerId} processing error:`, error);
      throw error;
    }
  }

  async processMessage(msg) {
    let order;
    
    try {
      order = JSON.parse(msg.content.toString());
      console.log(`${this.workerId} received order ${order.id}`);
      
      // Simulate potential processing failure for demonstration
      if (Math.random() < 0.1) { // 10% chance of failure
        throw new Error('Simulated processing failure');
      }
      
      // Process the order through different stages
      await this.processOrderStages(order);
      
      // Acknowledge the message on successful processing
      this.channel.ack(msg);
      console.log(`${this.workerId} completed order ${order.id}`);
      
    } catch (error) {
      console.error(`${this.workerId} error processing order ${order?.id || 'unknown'}:`, error);
      
      // Handle retry logic
      await this.handleRetry(msg, order, error);
    }
  }

  async processOrderStages(order) {
    const stages = ['Preparing', 'Ready for Pickup', 'Completed'];
    
    for (const stage of stages) {
      console.log(`${this.workerId} processing order ${order.id}: ${stage}`);
      
      // Update status
      await this.updateOrderStatus(order.id, stage);
      
      // Simulate processing time
      await this.sleep(this.PROCESSING_TIMES[stage]);
      
      // Random chance of failure at each stage (for demonstration)
      if (Math.random() < 0.05) { // 5% chance of failure at each stage
        throw new Error(`Processing failed at stage: ${stage}`);
      }
    }
  }

  async handleRetry(msg, order, error) {
    const retryCount = this.getRetryCount(msg);
    
    if (retryCount >= this.MAX_RETRIES) {
      console.log(`${this.workerId} max retries exceeded for order ${order?.id}, sending to DLQ`);
      
      // Send to dead letter queue
      await this.sendToDLQ(msg, order, error);
      this.channel.ack(msg);
      
      // Update order status to failed
      if (order?.id) {
        await this.updateOrderStatus(order.id, 'Failed', error.message);
      }
      
      return;
    }

    // Calculate exponential backoff delay
    const delay = this.calculateBackoffDelay(retryCount);
    
    console.log(`${this.workerId} retrying order ${order?.id} (attempt ${retryCount + 1}/${this.MAX_RETRIES}) after ${delay}ms`);
    
    // Create retry message with updated retry count
    const retryMessage = {
      ...order,
      retryCount: retryCount + 1,
      lastError: error.message,
      retryAt: new Date(Date.now() + delay).toISOString()
    };

    // Publish to retry queue with delay
    await this.channel.publish(
      this.RETRY_EXCHANGE,
      'retry',
      Buffer.from(JSON.stringify(retryMessage)),
      {
        persistent: true,
        headers: {
          'x-retry-count': retryCount + 1,
          'x-original-queue': this.QUEUE_NAME
        },
        expiration: delay.toString()
      }
    );

    // Acknowledge original message
    this.channel.ack(msg);
  }

  getRetryCount(msg) {
    return msg.properties.headers?.['x-retry-count'] || 0;
  }

  calculateBackoffDelay(retryCount) {
    // Exponential backoff: baseDelay * 2^retryCount + jitter
    const exponentialDelay = this.BASE_DELAY * Math.pow(2, retryCount);
    const jitter = Math.random() * 1000; // Add up to 1 second of jitter
    return Math.floor(exponentialDelay + jitter);
  }

  async sendToDLQ(msg, order, error) {
    const dlqMessage = {
      originalMessage: order,
      error: error.message,
      failedAt: new Date().toISOString(),
      workerId: this.workerId,
      retryCount: this.getRetryCount(msg)
    };

    await this.channel.sendToQueue(
      this.DLQ_NAME,
      Buffer.from(JSON.stringify(dlqMessage)),
      { persistent: true }
    );
  }

  async updateOrderStatus(orderId, status, errorMessage = null) {
    try {
      const payload = {
        status,
        workerId: this.workerId,
        updatedAt: new Date().toISOString()
      };
      
      if (errorMessage) {
        payload.errorMessage = errorMessage;
      }

      await axios.put(`${this.SERVER_URL}/api/orders/${orderId}/status`, payload);
    } catch (error) {
      console.error(`${this.workerId} failed to update order status:`, error.message);
      // Don't throw here to avoid infinite retry loops
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async shutdown() {
    console.log(`${this.workerId} shutting down...`);
    this.processing = false;
    
    if (this.channel) {
      await this.channel.close();
    }
    
    if (this.connection) {
      await this.connection.close();
    }
    
    console.log(`${this.workerId} shutdown complete`);
  }
}

// Create and start multiple workers for demonstration
class WorkerManager {
  constructor(workerCount = 3) {
    this.workers = [];
    this.workerCount = workerCount;
  }

  async startWorkers() {
    console.log(`Starting ${this.workerCount} workers...`);
    
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new OrderProcessor(`kitchen-worker-${i + 1}`);
      
      try {
        await worker.connect();
        await worker.startProcessing();
        this.workers.push(worker);
        
        console.log(`Worker ${worker.workerId} started successfully`);
      } catch (error) {
        console.error(`Failed to start worker ${worker.workerId}:`, error);
      }
    }
    
    console.log(`${this.workers.length} workers active`);
  }

  async shutdown() {
    console.log('Shutting down all workers...');
    
    await Promise.all(this.workers.map(worker => worker.shutdown()));
    
    console.log('All workers shut down');
  }
}

// Handle graceful shutdown
let workerManager;

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down workers...');
  if (workerManager) {
    await workerManager.shutdown();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down workers...');
  if (workerManager) {
    await workerManager.shutdown();
  }
  process.exit(0);
});

// Start workers if this file is run directly
if (require.main === module) {
  const workerCount = process.env.WORKER_COUNT || 3;
  workerManager = new WorkerManager(parseInt(workerCount));
  
  workerManager.startWorkers().catch(error => {
    console.error('Failed to start workers:', error);
    process.exit(1);
  });
}

module.exports = { OrderProcessor, WorkerManager };