require('dotenv').config();

const express = require('express');
const rateLimit = require('express-rate-limit');
const mqtt = require('mqtt');

const app = express();
app.set('trust proxy', true);

// =====================
// 設定の一元管理
// =====================
const config = {
  mqtt: {
    url: process.env.MQTT_URL,
    topic: process.env.MQTT_TOPIC,
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '1000', 10),     // デフォルト: 1秒
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '4', 10),  // デフォルト: 4回
  },
  server: {
    port: process.env.PORT || 3000,
  },
};

// =====================
// 設定のバリデーション
// =====================
function validateConfig() {
  // デバッグ: 環境変数の状態をログ出力
  logger.info(`DEBUG: process.env.MQTT_URL = ${process.env.MQTT_URL}`);
  logger.info(`DEBUG: process.env.MQTT_TOPIC = ${process.env.MQTT_TOPIC}`);
  logger.info(`DEBUG: config.mqtt.url = ${config.mqtt.url}`);
  logger.info(`DEBUG: config.mqtt.topic = ${config.mqtt.topic}`);
  
  if (!config.mqtt.url) {
    logger.error('MQTT_URL is not set in environment variables');
    process.exit(1);
  }
  if (!config.mqtt.topic) {
    logger.error('MQTT_TOPIC is not set in environment variables');
    process.exit(1);
  }

  // レート制限の検証
  if (config.rateLimit.windowMs <= 0) {
    logger.error('RATE_LIMIT_WINDOW_MS must be greater than 0');
    process.exit(1);
  }
  if (config.rateLimit.maxRequests <= 0) {
    logger.error('RATE_LIMIT_MAX_REQUESTS must be greater than 0');
    process.exit(1);
  }

  logger.info('Configuration validated successfully');
  logger.info(`[RATE_LIMIT] Window: ${config.rateLimit.windowMs}ms, Max Requests: ${config.rateLimit.maxRequests}`);
}

// =====================
// ロギング統一
// =====================
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
};

// =====================
// レート制限ミドルウェア
// =====================
const notifyLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,      // 1秒
  max: config.rateLimit.maxRequests,        // 最大4回
  keyGenerator: (req) => req.ip || req.connection.remoteAddress,
  skip: false,
  handler: (req, res, options) => {
    logger.warn(`[RATE_LIMIT_BLOCKED] IP: ${req.ip || req.connection.remoteAddress}`);
    res.status(429).json({ status: 'error', message: 'Too Many Requests' });
  },
  onLimitReached: (req, res, options) => {
    logger.warn(`[RATE_LIMIT_REACHED] IP: ${req.ip || req.connection.remoteAddress}`);
  },
});

// =====================
// MQTT マネージャークラス
// =====================
class MqttManager {
  constructor(mqttUrl, topic) {
    this.topic = topic;
    this.queue = [];
    this.connected = false;
    this.client = mqtt.connect(mqttUrl);
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.on('connect', () => this.handleConnect());
    this.client.on('reconnect', () => logger.info('[MQTT] reconnecting...'));
    this.client.on('error', (err) => logger.error(`[MQTT] error: ${err?.message}`));
    this.client.on('close', () => this.handleClose());
  }

  handleConnect() {
    this.connected = true;
    this.flushQueue();
    logger.info('[MQTT] connected');
  }

  handleClose() {
    this.connected = false;
    logger.info('[MQTT] closed');
  }

  flushQueue() {
    while (this.queue.length) {
      const { topic, message } = this.queue.shift();
      this.client.publish(topic, message);
    }
  }

  publish(message) {
    if (this.connected) {
      this.client.publish(this.topic, message);
    } else {
      this.queue.push({ topic: this.topic, message });
    }
  }
}

// =====================
// 起動前のバリデーション
// =====================
validateConfig();

// =====================
// インスタンス生成
// =====================
const mqttManager = new MqttManager(config.mqtt.url, config.mqtt.topic);

// =====================
// ルート定義
// =====================
app.get('/notify', notifyLimiter, (req, res) => {
  const message = req.query.message || 'No message';
  mqttManager.publish(message);

  res.json({ status: 'ok', topic: config.mqtt.topic, message });
});

// ヘルスチェック用
app.get('/healthz', (_req, res) => res.send('ok'));

// =====================
// サーバー起動
// =====================
app.listen(config.server.port, '0.0.0.0', () => {
  logger.info(`[SERVER] HTTP listening on :${config.server.port}`);
});
