FROM node:20-alpine
RUN apk add --allow-untrusted --update --no-cache curl ca-certificates
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
