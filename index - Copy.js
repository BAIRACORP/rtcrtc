import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Store active users - using userId as key for easier lookup
const users = new Map(); // userId -> { userId, username, socketId }
const socketToUser = new Map(); // socketId -> userId
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register-user', ({ userId, username }) => {
    // Store user with userId as key
    users.set(userId, { userId, username, socketId: socket.id });
    socketToUser.set(socket.id, userId);
    socket.userId = userId;
    
    console.log(`User registered: ${username} (${userId}) - Socket: ${socket.id}`);
    console.log('Total users:', users.size);
    
    // Broadcast updated user list to all clients
    const userList = Array.from(users.values());
    io.emit('users-updated', userList);
    console.log('Broadcasting user list to all clients:', userList.map(u => u.username));
  });

  socket.on('call-user', ({ targetUserId, callerInfo, offer }) => {
    console.log(`\n=== CALL REQUEST ===`);
    console.log(`From: ${callerInfo.username} (${callerInfo.id})`);
    console.log(`To: ${targetUserId}`);
    console.log(`Available users:`, Array.from(users.keys()));
    
    // Find target user by userId
    const targetUser = users.get(targetUserId);
    
    if (targetUser) {
      console.log(`✓ Found target user: ${targetUser.username} (Socket: ${targetUser.socketId})`);
      
      // Send incoming call to target user
      io.to(targetUser.socketId).emit('incoming-call', {
        caller: callerInfo,
        offer,
        callId: socket.id
      });
      
      console.log(`✓ Sent incoming-call event to ${targetUser.socketId}`);
      
      // Confirm to caller that call was sent
      socket.emit('call-initiated', { 
        targetUser: { username: targetUser.username, id: targetUser.userId }
      });
      
    } else {
      console.log(`✗ Target user ${targetUserId} not found`);
      console.log(`Available users:`, Array.from(users.entries()));
      
      // Send error back to caller
      socket.emit('call-failed', { 
        error: 'User not found or offline',
        targetUserId 
      });
    }
  });

  socket.on('answer-call', ({ callId, answer, userInfo }) => {
    console.log(`\n=== CALL ANSWERED ===`);
    console.log(`By: ${userInfo.username}`);
    console.log(`Sending answer to caller: ${callId}`);
    
    // Send answer back to caller
    io.to(callId).emit('call-answered', { 
      answer, 
      userInfo 
    });
    
    console.log(`✓ Sent call-answered event to ${callId}`);
  });

  socket.on('reject-call', ({ callId }) => {
    console.log(`\n=== CALL REJECTED ===`);
    console.log(`Rejecting call from: ${callId}`);
    
    // Notify caller that call was rejected
    io.to(callId).emit('call-rejected');
    
    console.log(`✓ Sent call-rejected event to ${callId}`);
  });

  socket.on('end-call', ({ targetSocketId }) => {
    console.log(`\n=== CALL ENDED ===`);
    console.log(`Ending call, notifying: ${targetSocketId}`);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-ended');
      console.log(`✓ Sent call-ended event to ${targetSocketId}`);
    }
  });

  socket.on('ice-candidate', ({ targetSocketId, candidate }) => {
    console.log(`ICE candidate: ${socket.id} -> ${targetSocketId}`);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', { 
        candidate,
        fromSocketId: socket.id 
      });
    }
  });

  // Room-based calling functionality
  socket.on('join-room', ({ roomId, userInfo }) => {
    console.log(`User ${userInfo.username} joining room ${roomId}`);
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    
    rooms.get(roomId).add({
      socketId: socket.id,
      userInfo
    });

    // Notify others in the room
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userInfo
    });

    // Send current room members to the new user
    const roomMembers = Array.from(rooms.get(roomId));
    socket.emit('room-members', roomMembers.filter(member => member.socketId !== socket.id));
  });

  socket.on('leave-room', ({ roomId }) => {
    console.log(`User leaving room ${roomId}`);
    socket.leave(roomId);
    
    if (rooms.has(roomId)) {
      const roomMembers = rooms.get(roomId);
      roomMembers.forEach(member => {
        if (member.socketId === socket.id) {
          roomMembers.delete(member);
        }
      });
      
      // Notify others in the room
      socket.to(roomId).emit('user-left', { socketId: socket.id });
    }
  });

  socket.on('room-offer', ({ roomId, targetSocketId, offer }) => {
    console.log(`Room offer from ${socket.id} to ${targetSocketId} in room ${roomId}`);
    io.to(targetSocketId).emit('room-offer', {
      offer,
      callerSocketId: socket.id
    });
  });

  socket.on('room-answer', ({ targetSocketId, answer }) => {
    console.log(`Room answer from ${socket.id} to ${targetSocketId}`);
    io.to(targetSocketId).emit('room-answer', { answer });
  });

  socket.on('room-ice-candidate', ({ targetSocketId, candidate }) => {
    console.log(`Room ICE candidate from ${socket.id} to ${targetSocketId}`);
    io.to(targetSocketId).emit('room-ice-candidate', { candidate });
  });

  socket.on('disconnect', () => {
    console.log(`\n=== USER DISCONNECTED ===`);
    console.log(`Socket: ${socket.id}`);
    
    // Get user info before removing
    const userId = socketToUser.get(socket.id);
    const disconnectedUser = userId ? users.get(userId) : null;
    
    if (disconnectedUser) {
      console.log(`Removing user: ${disconnectedUser.username} (${userId})`);
      users.delete(userId);
    }
    socketToUser.delete(socket.id);
    
    // Remove from all rooms
    rooms.forEach((roomMembers, roomId) => {
      roomMembers.forEach(member => {
        if (member.socketId === socket.id) {
          roomMembers.delete(member);
          // Notify others in the room
          socket.to(roomId).emit('user-left', { socketId: socket.id });
        }
      });
    });
    
    // Broadcast updated user list
    const userList = Array.from(users.values());
    io.emit('users-updated', userList);
    console.log(`Updated user list after disconnect: ${userList.length} users`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});