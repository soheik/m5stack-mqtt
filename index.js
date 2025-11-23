const express = require('express');
const mqtt = require('mqtt');

const app = express();

// 既定は HiveMQ の公開ブローカー。認証が必要なら環境変数で上書き。
// 例) MQTT_URL=mqtt://user:pass@broker.example.com:1883
const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'm5/notify-bomb';

// 接続（自動再接続有効）
const mqttClient = mqtt.connect(MQTT_URL);

// つながっていない瞬間の publish を吸収するシンプルなキュー
const queue = [];
let connected = false;

// ★ レート制限用（IPごとに記録）
const rateLimitStore = new Map();

// 設定値（お好みで調整）
const WINDOW_MS = 1 * 1000;       // 1秒間の窓
const MAX_REQUESTS = 3;           // 1秒間に最大3回まで

// レート制限チェック関数
function isOverLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || { count: 0, start: now };

  // 窓の期間を過ぎていたらリセット
  if (now - entry.start > WINDOW_MS) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count += 1;
  }

  rateLimitStore.set(ip, entry);

  return entry.count > MAX_REQUESTS;
}

mqttClient.on('connect', () => {
  connected = true;
  while (queue.length) {
    const { topic, message } = queue.shift();
    mqttClient.publish(topic, message);
  }
  console.log('[MQTT] connected');
});

mqttClient.on('reconnect', () => console.log('[MQTT] reconnecting...'));
mqttClient.on('error', (err) => console.error('[MQTT] error:', err?.message));
mqttClient.on('close', () => { connected = false; console.log('[MQTT] closed'); });

app.get('/notify', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  // ★ レート制限
  if (isOverLimit(ip)) {
    console.warn(`[RATE LIMIT] too many requests from ${ip}`);
    return res.status(429).json({ status: 'error', message: 'Too Many Requests' });
  }

  const message = req.query.message || 'No message';
  if (connected) {
    mqttClient.publish(MQTT_TOPIC, message);
  } else {
    queue.push({ topic: MQTT_TOPIC, message });
  }
  res.json({ status: 'ok', topic: MQTT_TOPIC, message });
});

// 健康チェック用（Railwayのヘルスチェックにも使える）
app.get('/healthz', (_req, res) => res.send('ok'));

// RailwayのPORTを必ず使う & 0.0.0.0 でbind
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP listening on :${PORT}`);
});
