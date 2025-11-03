const express = require('express');
const mqtt = require('mqtt');

const app = express();

// 既定は HiveMQ の公開ブローカー。認証が必要なら環境変数で上書き。
// 例) MQTT_URL=mqtt://user:pass@broker.example.com:1883
const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'm5/notify';

// 接続（自動再接続有効）
const mqttClient = mqtt.connect(MQTT_URL);

// つながっていない瞬間の publish を吸収するシンプルなキュー
const queue = [];
let connected = false;

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
