const { logActivity } = require('../services/loggerService');

const requestLogger = (req, res, next) => {
  // Skip logging for static files or common noise
  if (req.originalUrl.startsWith('/uploads') || req.method === 'OPTIONS') {
    return next();
  }

  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    
    // Determine action name based on method
    let action = 'API_REQUEST';
    if (req.method === 'DELETE') action = 'API_DELETE';
    if (req.method === 'POST') action = 'API_CREATE';
    if (req.method === 'PUT' || req.method === 'PATCH') action = 'API_UPDATE';

    // Log the activity
    logActivity(req, action, { duration: `${duration}ms` }, res.statusCode);
  });

  next();
};

module.exports = requestLogger;
