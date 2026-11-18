// Socket.IO singleton accessor
let io = null;

export function setIO(socketServer) {
  io = socketServer;
}

export function getIO() {
  return io;
}

export function emitToRoom(event, data, establishmentId) {
  if (!io) return;
  if (establishmentId) io.to(`est:${establishmentId}`).emit(event, data);
  else io.emit(event, data);
}