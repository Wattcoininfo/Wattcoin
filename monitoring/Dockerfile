FROM node:20-alpine

WORKDIR /app

RUN npm init -y \
  && npm install --omit=dev ssh2@^1.17.0 \
  && mkdir -p /app/monitoring /config /var/lib/wattcoin-monitoring

COPY monitoring/wattcoin-monitoring-collector.cjs /app/monitoring/wattcoin-monitoring-collector.cjs

EXPOSE 9464

CMD ["node", "/app/monitoring/wattcoin-monitoring-collector.cjs", "--config", "/config/nodes.json"]