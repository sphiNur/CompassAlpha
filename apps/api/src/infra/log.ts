import pino from 'pino';
import { env } from '../env';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  base: { service: 'compass-api', env: env.NODE_ENV },
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.refreshToken'],
});

export type Logger = typeof logger;
