const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('redis'); // Import createClient from 'redis'
const { createAdapter } = require('@socket.io/redis-adapter'); // Import createAdapter

const app = express();
const server = http.createServer(app);

// Use cors middleware for Express
app.use(cors()); // Allow all origins for Express routes

// Set the port
const PORT = process.env.PORT || 3001;

// Initialize Socket.IO server
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for Socket.IO connections
    methods: ["GET", "POST"]
  }
});

// ----- Socket.IO Redis Adapter Configuration -----
const pubClient = createClient({ url: process.env.REDIS_URL }); // Use your Redis URL from environment variables
const subClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect()])
  .then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log('Redis adapter connected successfully.');

    // Start listening for connections only after Redis clients are connected
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to Redis:', err);
    // Handle error or exit if Redis connection is critical for your app
    process.exit(1);
  });
// --------------------------------------------------

// In-memory user store (will need to be revisited for true scalability with Redis)
let connectedUsers = [];

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register-user', ({ userId, username }) => {
    const newUser = { id: userId, username, socketId: socket.id };
    // Check if user already exists based on userId (or unique identifier)
    const existingUserIndex = connectedUsers.findIndex(u => u.id === userId);

    if (existingUserIndex > -1) {
      // Update existing user's socketId if they reconnect
      connectedUsers[existingUserIndex].socketId = socket.id;
      console.log(`User ${username} re-registered with new socket ID: ${socket.id}`);
    } else {
      connectedUsers.push(newUser);
      console.log(`User registered: ${username} (${userId})`);
    }

    // Emit updated users to all connected clients (excluding the current user, done on client)
    io.emit('users-updated', connectedUsers); // Emit to all including sender initially, client filters itself
  });

  socket.on('disconnect', (reason) => {
    console.log('=== USER DISCONNECTED ===');
    console.log('Socket:', socket.id);
    const disconnectedUserIndex = connectedUsers.findIndex(u => u.socketId === socket.id);
    if (disconnectedUserIndex > -1) {
      const [disconnectedUser] = connectedUsers.splice(disconnectedUserIndex, 1);
      console.log(`Removing user: ${disconnectedUser.username} (${disconnectedUser.id})`);
      io.emit('users-updated', connectedUsers); // Notify others of disconnect
    }
    console.log('Updated user list after disconnect:', connectedUsers.length, 'users');
    console.log(`Disconnected from server (reason: ${reason})`);
  });

  socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
  });

  socket.on('signal', (data) => {
    console.log(`Signal from ${socket.id} to ${data.target}:`, data.signal);
    io.to(data.target).emit('signal', { sender: socket.id, signal: data.signal });
  });
});

// For Vercel, ensure you're exporting the Express app if needed for other routes
// module.exports = app; // if you have other API routes