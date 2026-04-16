# Tienda Back - Microservicios Docker

Este backend esta dividido en microservicios con Docker Compose.

## Puertos

- API Gateway: `9000`
- Auth Service: `9001`
- Store Service: `9002`
- Product Service: `9003`
- Auction Service: `9004`
- Order Service: `9005`
- Finance Service: `9006`

## Levantar todo

```bash
docker compose up --build
```

## Pruebas rapidas

- Health gateway: `http://localhost:9000/health`
- Health auth: `http://localhost:9001/health`
- Health stores: `http://localhost:9002/health`
- Health products: `http://localhost:9003/health`
- Health auctions: `http://localhost:9004/health`
- Health orders: `http://localhost:9005/health`
- Health finance: `http://localhost:9006/health`

## Rutas via gateway

- `GET http://localhost:9000/auth/me`
- `GET http://localhost:9000/stores/featured`
- `GET http://localhost:9000/products/featured`
- `GET http://localhost:9000/auctions/active`
- `GET http://localhost:9000/orders`
- `GET http://localhost:9000/finance/giftcards`
- `GET http://localhost:9000/finance/transactions`
- `GET http://localhost:9000/finance/dashboard/summary`
