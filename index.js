import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

const users = new Map();           // userId -> { userId, username, socketId }
const socketToUser = new Map();    // socketId -> userId
const rooms = new Map();           // roomId -> Set of participants

io.on('connection', (socket) => {
  console.log('✅ New socket connected:', socket.id);

  socket.on('register-user', ({ userId, username }) => {
    users.set(userId, { userId, username, socketId: socket.id });
    socketToUser.set(socket.id, userId);
    socket.userId = userId;

    console.log(`👤 Registered: ${username} (${userId})`);
    io.emit('users-updated', Array.from(users.values()));
  });

  socket.on('call-user', ({ targetUserId, callerInfo, offer }) => {
    console.log('\n📞 Incoming call request');
    
    if (!callerInfo || !callerInfo.id || !callerInfo.username) {
      console.warn('⚠️ Invalid callerInfo:', callerInfo);
      socket.emit('call-failed', { error: 'Invalid caller information.' });
      return;
    }

    const targetUser = users.get(targetUserId);
    if (!targetUser) {
      console.warn(`❌ Target user ${targetUserId} not found`);
      socket.emit('call-failed', {
        error: 'Target user not found or offline.',
        targetUserId,
      });
      return;
    }

    console.log(`🔹 Caller: ${callerInfo.username} (${callerInfo.id})`);
    console.log(`🔸 Target: ${targetUser.username} (${targetUser.userId})`);

    io.to(targetUser.socketId).emit('incoming-call', {
      caller: callerInfo,
      offer,
      callId: socket.id,
    });

    socket.emit('call-initiated', {
      targetUser: {
        username: targetUser.username,
        id: targetUser.userId,
      },
    });
  });

  socket.on('answer-call', ({ callId, answer, userInfo }) => {
    console.log(`✅ Call answered by ${userInfo?.username}`);
    io.to(callId).emit('call-answered', { answer, userInfo });
  });

  socket.on('reject-call', ({ callId }) => {
    console.log(`🚫 Call rejected. Notifying ${callId}`);
    io.to(callId).emit('call-rejected');
  });

  socket.on('end-call', ({ targetSocketId }) => {
    console.log(`📴 Call ended. Notifying ${targetSocketId}`);
    io.to(targetSocketId).emit('call-ended');
  });

  socket.on('ice-candidate', ({ targetSocketId, candidate }) => {
    console.log(`❄️ ICE candidate: ${socket.id} ➜ ${targetSocketId}`);
    io.to(targetSocketId).emit('ice-candidate', {
      candidate,
      fromSocketId: socket.id,
    });
  });

  // Room logic (optional)
  socket.on('join-room', ({ roomId, userInfo }) => {
    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId).add({ socketId: socket.id, userInfo });

    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userInfo,
    });

    const roomMembers = Array.from(rooms.get(roomId)).filter(
      (m) => m.socketId !== socket.id
    );
    socket.emit('room-members', roomMembers);
  });

  socket.on('leave-room', ({ roomId }) => {
    socket.leave(roomId);
    const room = rooms.get(roomId);
    if (room) {
      room.forEach((member) => {
        if (member.socketId === socket.id) room.delete(member);
      });
      socket.to(roomId).emit('user-left', { socketId: socket.id });
    }
  });

  socket.on('room-offer', ({ roomId, targetSocketId, offer }) => {
    io.to(targetSocketId).emit('room-offer', {
      offer,
      callerSocketId: socket.id,
    });
  });

  socket.on('room-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('room-answer', { answer });
  });

  socket.on('room-ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('room-ice-candidate', { candidate });
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
    const userId = socketToUser.get(socket.id);
    const user = users.get(userId);

    if (userId) {
      users.delete(userId);
      socketToUser.delete(socket.id);
      console.log(`🗑️ Removed user: ${user?.username || 'Unknown'} (${userId})`);
    }

    rooms.forEach((room, roomId) => {
      room.forEach((member) => {
        if (member.socketId === socket.id) {
          room.delete(member);
          socket.to(roomId).emit('user-left', { socketId: socket.id });
        }
      });
    });

    io.emit('users-updated', Array.from(users.values()));
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
