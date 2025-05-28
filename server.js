// server.js - Main API Server and Queue Publisher
const express = require('express');
const amqp = require('amqplib');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class RestaurantOrderSystem {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });
    this.connection = null;
    this.channel = null;
    this.orders = new Map(); // In-memory order storage (use DB in production)
    
    // Queue configuration
    this.QUEUE_NAME = 'restaurant_orders';
    this.EXCHANGE_NAME = 'restaurant_exchange';
    this.DLQ_NAME = 'restaurant_orders_dlq';
    this.RETRY_EXCHANGE = 'restaurant_retry_exchange';
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // Create new order
    this.app.post('/api/orders', async (req, res) => {
      try {
        const { items, customerName, phoneNumber, notes } = req.body;
        
        if (!items || !items.length || !customerName) {
          return res.status(400).json({ 
            error: 'Missing required fields: items and customerName' 
          });
        }

        const order = {
          id: uuidv4(),
          items,
          customerName,
          phoneNumber: phoneNumber || '',
          notes: notes || '',
          status: 'Received',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          retryCount: 0,
          totalAmount: this.calculateTotal(items)
        };

        // Store order
        this.orders.set(order.id, order);

        // Publish to queue
        await this.publishOrder(order);

        // Broadcast to WebSocket clients
        this.broadcastOrderUpdate(order);

        res.status(201).json({ 
          success: true, 
          orderId: order.id,
          order 
        });
      } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ error: 'Failed to create order' });
      }
    });

    // Get all orders
    this.app.get('/api/orders', (req, res) => {
      const orders = Array.from(this.orders.values()).sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );
      res.json(orders);
    });

    // Get specific order
    this.app.get('/api/orders/:id', (req, res) => {
      const order = this.orders.get(req.params.id);
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }
      res.json(order);
    });

    // Update order status (for manual updates)
    this.app.put('/api/orders/:id/status', async (req, res) => {
      try {
        const { status } = req.body;
        const order = this.orders.get(req.params.id);
        
        if (!order) {
          return res.status(404).json({ error: 'Order not found' });
        }

        const validStatuses = ['Received', 'Preparing', 'Ready for Pickup', 'Completed'];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ 
            error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') 
          });
        }

        order.status = status;
        order.updatedAt = new Date().toISOString();
        
        this.orders.set(order.id, order);
        this.broadcastOrderUpdate(order);

        res.json({ success: true, order });
      } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Failed to update order status' });
      }
    });

    // Dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });
  }

  setupWebSocket() {
    this.wss.on('connection', (ws) => {
      console.log('New WebSocket connection established');
      
      // Send current orders to new client
      const orders = Array.from(this.orders.values());
      ws.send(JSON.stringify({ type: 'initial_orders', orders }));
      
      ws.on('close', () => {
        console.log('WebSocket connection closed');
      });
    });
  }

  calculateTotal(items) {
    return items.reduce((total, item) => {
      return total + (item.price * item.quantity);
    }, 0);
  }

  async setupRabbitMQ() {
    try {
      // Connect to RabbitMQ
      this.connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
      this.channel = await this.connection.createChannel();

      // Create exchange
      await this.channel.assertExchange(this.EXCHANGE_NAME, 'direct', { durable: true });
      await this.channel.assertExchange(this.RETRY_EXCHANGE, 'direct', { durable: true });

      // Create main queue
      await this.channel.assertQueue(this.QUEUE_NAME, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': this.RETRY_EXCHANGE,
          'x-dead-letter-routing-key': 'retry'
        }
      });

      // Create dead letter queue
      await this.channel.assertQueue(this.DLQ_NAME, { durable: true });

      // Create retry queue with TTL
      await this.channel.assertQueue('restaurant_orders_retry', {
        durable: true,
        arguments: {
          'x-message-ttl': 5000, // 5 seconds initial retry delay
          'x-dead-letter-exchange': this.EXCHANGE_NAME,
          'x-dead-letter-routing-key': 'order'
        }
      });

      // Bind queues
      await this.channel.bindQueue(this.QUEUE_NAME, this.EXCHANGE_NAME, 'order');
      await this.channel.bindQueue('restaurant_orders_retry', this.RETRY_EXCHANGE, 'retry');

      console.log('RabbitMQ setup completed');
    } catch (error) {
      console.error('RabbitMQ setup failed:', error);
      throw error;
    }
  }

  async publishOrder(order) {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not available');
    }

    const message = Buffer.from(JSON.stringify(order));
    
    return this.channel.publish(
      this.EXCHANGE_NAME,
      'order',
      message,
      {
        persistent: true,
        messageId: order.id,
        timestamp: Date.now()
      }
    );
  }

  broadcastOrderUpdate(order) {
    const message = JSON.stringify({ type: 'order_update', order });
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // Method to update order from consumer
  updateOrderStatus(orderId, status, workerId = null) {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = status;
      order.updatedAt = new Date().toISOString();
      if (workerId) {
        order.processedBy = workerId;
      }
      
      this.orders.set(orderId, order);
      this.broadcastOrderUpdate(order);
      
      console.log(`Order ${orderId} updated to ${status} by ${workerId || 'system'}`);
    }
  }

  async start(port = 3000) {
    try {
      await this.setupRabbitMQ();
      
      this.server.listen(port, () => {
        console.log(`Restaurant Order System running on port ${port}`);
        console.log(`Dashboard: http://localhost:${port}`);
        console.log(`API: http://localhost:${port}/api/orders`);
      });
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  async shutdown() {
    console.log('Shutting down gracefully...');
    
    if (this.channel) {
      await this.channel.close();
    }
    
    if (this.connection) {
      await this.connection.close();
    }
    
    this.server.close();
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully');
  if (global.orderSystem) {
    await global.orderSystem.shutdown();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully');
  if (global.orderSystem) {
    await global.orderSystem.shutdown();
  }
  process.exit(0);
});

// Start the server
if (require.main === module) {
  global.orderSystem = new RestaurantOrderSystem();
  global.orderSystem.start(process.env.PORT || 3000);
}

module.exports = RestaurantOrderSystem;