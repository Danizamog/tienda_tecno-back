const express = require('express')
const cors = require('cors')
const morgan = require('morgan')
const { createProxyMiddleware } = require('http-proxy-middleware')

const app = express()
const PORT = Number(process.env.PORT || 9000)

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:9001'
const STORE_SERVICE_URL = process.env.STORE_SERVICE_URL || 'http://store-service:9002'
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://product-service:9003'
const AUCTION_SERVICE_URL = process.env.AUCTION_SERVICE_URL || 'http://auction-service:9004'
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:9005'
const FINANCE_SERVICE_URL = process.env.FINANCE_SERVICE_URL || 'http://finance-service:9006'
const WISHLIST_SERVICE_URL = process.env.WISHLIST_SERVICE_URL || 'http://wishlist-service:9007'
const REVIEW_SERVICE_URL    = process.env.REVIEW_SERVICE_URL    || 'http://review-service:9008'
const GIFTCARD_SERVICE_URL   = process.env.GIFTCARD_SERVICE_URL   || 'http://giftcard-service:9009'
const DASHBOARD_SERVICE_URL       = process.env.DASHBOARD_SERVICE_URL       || 'http://dashboard-service:9010'
const STORE_FOLLOWERS_SERVICE_URL = process.env.STORE_FOLLOWERS_SERVICE_URL || 'http://store-followers-service:9011'
const BID_ORDER_SERVICE_URL       = process.env.BID_ORDER_SERVICE_URL       || 'http://bid-order-service:9012'
const TRANSACTION_SERVICE_URL     = process.env.TRANSACTION_SERVICE_URL     || 'http://transaction-service:9013'
const CART_SERVICE_URL            = process.env.CART_SERVICE_URL            || 'http://cart-service:9014'

app.use(cors())
app.use(morgan('dev'))

app.get('/health', (_req, res) => {
  res.json({ service: 'api-gateway', ok: true, port: PORT })
})

app.get('/', (_req, res) => {
  res.json({
    service: 'api-gateway',
    ok: true,
    routes: ['/auth', '/stores', '/products', '/auctions', '/orders', '/finance', '/wishlist', '/reviews', '/giftcards', '/dashboard', '/followers', '/orders-bid', '/transactions', '/cart'],
  })
})

app.use('/auth', createProxyMiddleware({ target: AUTH_SERVICE_URL, changeOrigin: true }))
app.use('/stores', createProxyMiddleware({ target: STORE_SERVICE_URL, changeOrigin: true }))
app.use('/products', createProxyMiddleware({ target: PRODUCT_SERVICE_URL, changeOrigin: true }))
app.use('/auctions', createProxyMiddleware({ target: AUCTION_SERVICE_URL, changeOrigin: true }))
app.use('/orders', createProxyMiddleware({ target: ORDER_SERVICE_URL, changeOrigin: true }))
app.use('/finance', createProxyMiddleware({ target: FINANCE_SERVICE_URL, changeOrigin: true }))
app.use('/wishlist', createProxyMiddleware({ target: WISHLIST_SERVICE_URL, changeOrigin: true }))
app.use('/reviews',   createProxyMiddleware({ target: REVIEW_SERVICE_URL,   changeOrigin: true }))
app.use('/giftcards',  createProxyMiddleware({ target: GIFTCARD_SERVICE_URL,  changeOrigin: true }))
app.use('/dashboard', createProxyMiddleware({ target: DASHBOARD_SERVICE_URL, changeOrigin: true }))
app.use('/followers',   createProxyMiddleware({ target: STORE_FOLLOWERS_SERVICE_URL, changeOrigin: true }))
app.use('/orders-bid', createProxyMiddleware({ target: BID_ORDER_SERVICE_URL,       changeOrigin: true }))
app.use('/transactions', createProxyMiddleware({ target: TRANSACTION_SERVICE_URL,   changeOrigin: true }))
app.use('/cart',         createProxyMiddleware({ target: CART_SERVICE_URL,          changeOrigin: true }))

app.listen(PORT, () => {
  console.log(`api-gateway running on port ${PORT}`)
})
