const express = require('express');
const mqtt = require('mqtt');

const app = express();
app.set('trust proxy', true);

// =====================
// 設定の一元管理
// =====================
const config = {
  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://broker.hivemq.com',
    topic: process.env.MQTT_TOPIC || 'm5/notify-bomb',
  },
  rateLimit: {
    windowMs: 10 * 1000,  // 10秒間の窓
    maxRequests: 2,        // 10秒間に最大2回まで
  },
  server: {
    port: process.env.PORT || 3000,
  },
};

// =====================
// ロギング統一
// =====================
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
};

// =====================
// レート制限クラス
// =====================
class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.store = new Map();
  }

  checkLimit(ip) {
    const now = Date.now();
    const entry = this.store.get(ip) || { count: 0, start: now };

    // 窓の期間を過ぎていたらリセット
    if (now - entry.start > this.windowMs) {
      entry.count = 0;
      entry.start = now;
    }

    // 制限を超えたら拒否
    if (entry.count >= this.maxRequests) {
      logger.warn(`[RATE_LIMIT_BLOCKED] IP: ${ip}, Count: ${entry.count}/${this.maxRequests}`);
      return true;
    }

    // 制限内なら、カウント増加
    entry.count += 1;
    this.store.set(ip, entry);

    logger.info(`[RATE_CHECK] IP: ${ip}, Count: ${entry.count}/${this.maxRequests}, Allowed`);

    return false;
  }
}

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
// インスタンス生成
// =====================
const rateLimiter = new RateLimiter(config.rateLimit.windowMs, config.rateLimit.maxRequests);
const mqttManager = new MqttManager(config.mqtt.url, config.mqtt.topic);

// =====================
// ルート定義
// =====================
app.get('/notify', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  // レート制限チェック
  if (rateLimiter.checkLimit(ip)) {
    return res.status(429).json({ status: 'error', message: 'Too Many Requests' });
  }

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
