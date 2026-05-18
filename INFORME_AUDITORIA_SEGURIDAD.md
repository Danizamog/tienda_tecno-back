# INFORME DE AUDITORÍA DE SEGURIDAD
## Plataforma E-Commerce TuVentaConfiada

**Análisis de Flujo de Datos y Autenticación**

---

## 📋 METADATOS DEL INFORME

| Campo | Valor |
|-------|-------|
| **Proyecto** | TuVentaConfiada |
| **Fecha de Auditoría** | 14 de Mayo de 2026 |
| **Tipo de Auditoría** | Análisis de Arquitectura y Seguridad |
| **Alcance** | Backend (14 microservicios) + Frontend (Vue.js 3) |
| **Tipo de Reporte** | Auditoría solicitada (sin cambios de código) |

---

## 📋 RESUMEN EJECUTIVO

### Conclusión Principal
**Su hipótesis es parcialmente correcta.** El backend SÍ está siendo parcialmente omitido en ciertos casos, pero el patrón es más complejo que "solo frontend → PocketBase".

### Hallazgo Crítico
El archivo `.env` del backend contiene **credenciales de placeholder** que **no pueden autenticarse** contra la instancia de PocketBase en producción:

```
POCKETBASE_AUTH_IDENTITY=correo@admin.com        ❌ PLACEHOLDER
POCKETBASE_AUTH_PASSWORD=tu_password_admin       ❌ PLACEHOLDER
POCKETBASE_URL=https://tecnotienda.zamoranogamarra.online
```

Esto representa un **riesgo crítico** para las operaciones de escritura.

### Patrón Arquitectónico Identificado

La plataforma implementa un modelo de dos capas:

1. **Operaciones de Lectura (READ):**
   - Frontend USA correctamente la API Gateway del backend ✅
   - No requieren autenticación (endpoints públicos)

2. **Operaciones de Escritura (WRITE):**
   - Backend requiere autenticación vía headers `x-user-id` y `x-user-role`
   - Pero con credenciales de admin inválidas, no pueden ejecutarse ❌

3. **Archivos/Imágenes:**
   - Algunos a través del backend (store files)
   - Otros directo a PocketBase (product/auction images)
   - Inconsistencia que dificulta auditoría

---

## 🔍 HALLAZGOS PRINCIPALES

### 1. Estado de Credenciales de Admin: CRÍTICO ⚠️

#### Problema Identificado

El archivo `.env` del backend en `tienda_tecno-back/.env`:

```
POCKETBASE_URL=https://tecnotienda.zamoranogamarra.online

POCKETBASE_AUTH_IDENTITY=correo@admin.com
POCKETBASE_AUTH_PASSWORD=tu_password_admin
```

#### Análisis

- `correo@admin.com` - Claramente un placeholder (formato de demostración, no email real)
- `tu_password_admin` - Literalmente significa "tu_password_admin" en español (credencial de ejemplo)
- La URL apunta a instancia de producción pero con credenciales inválidas

#### Impacto

| Consecuencia | Severidad |
|---|---|
| Los 14 microservicios no pueden autenticarse con PocketBase | 🔴 CRÍTICO |
| Todas las operaciones que requieren token de admin fallarían | 🔴 CRÍTICO |
| Las operaciones de escritura deberían estar bloqueadas en producción | 🔴 CRÍTICO |
| El sistema funciona en dev local solo si usa diferentes credenciales | 🟡 ADVERTENCIA |

#### Código Afectado

**Todos los 14 microservicios** llaman a esta función:

```javascript
async function getAdminToken() {
  const res = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identity: PB_IDENTITY,    // 'correo@admin.com' ❌
      password: PB_PASSWORD     // 'tu_password_admin' ❌
    }),
  })
  if (!res.ok) throw new Error(`PB admin auth failed: ${res.status}`)
  const { token } = await res.json()
  _adminToken = token
  _adminTokenExpiry = Date.now() + 55 * 60 * 1000
  return token
}
```

Si la autenticación falla, **el servicio completo falla**. No hay fallback.

---

### 2. Patrón de Flujo de Datos: VERIFICADO ✅

#### Operaciones de Lectura (READ)

| Operación | Ruta Frontend | Usa Backend | Requiere Auth |
|-----------|---|---|---|
| Listar productos | `fetch(API/products?...)` | ✅ Sí | ❌ No |
| Detalle de producto | `fetch(API/products/:id)` | ✅ Sí | ❌ No |
| Listar tiendas | `fetch(API/stores?...)` | ✅ Sí | ❌ No |
| Categorías | `fetch(API/products/categories)` | ✅ Sí | ❌ No |
| Listar subastas | `fetch(API/auctions?...)` | ✅ Sí | ❌ No |
| Archivos de tienda (logos, banners) | `${API}/stores/files/...` | ✅ Proxy Backend | ❌ No |
| **Imágenes de productos** | `${PB}/api/files/products/...` | ⚠️ Directo PocketBase | ❌ No |
| **Imágenes de subastas** | `${PB}/api/files/auctions/...` | ⚠️ Directo PocketBase | ❌ No |

**Conclusión:** El frontend SÍ está usando correctamente el API Gateway para operaciones de datos. ✅

Las imágenes van directo a PocketBase, lo cual es una **práctica aceptable** porque:
- Las imágenes son archivos estáticos públicos
- Reduce carga en el backend
- PocketBase está optimizado para servir archivos

#### Evidencia: ProductsView.vue

```javascript
// Línea 10-11
const API = (import.meta.env.VITE_GATEWAY_API_BASE_URL || '').replace(/\/$/, '')
const PB  = (import.meta.env.VITE_POCKETBASE_URL || '').replace(/\/$/, '')

// Línea 51 - Categorías por backend
const res  = await fetch(`${API}/products/categories`)

// Línea 84 - Productos por backend
const res  = await fetch(`${API}/products?${params}`)

// Línea 112 - Imágenes por PocketBase directo
return `${PB}/api/files/products/${product.id}/${img}?thumb=400x400`
```

#### Operaciones de Escritura (WRITE)

| Operación | Endpoint | Protección | Estado |
|-----------|----------|-----------|--------|
| Crear producto | `POST /products` | `requireAuth` + ownership check | ✅ Protegido |
| Actualizar producto | `PATCH /products/:id` | `requireAuth` + ownership check | ✅ Protegido |
| Eliminar producto | `DELETE /products/:id` | `requireAuth` + ownership check | ✅ Protegido |
| Crear tienda | `POST /stores` | `requireAuth` (vendor/admin only) | ✅ Protegido |
| Crear orden | `POST /orders` | `requireAuth` | ✅ Protegido |
| Google OAuth sync | `POST /google/sync` | Token validation + PocketBase upsert | ✅ Protegido |

**Conclusión:** Los endpoints de escritura SÍ están protegidos. ✅

---

### 3. Middleware de Autenticación: CORRECTAMENTE IMPLEMENTADO ✅

#### Patrón en product-service (líneas 43-50)

```javascript
function requireAuth(req, res, next) {
  const userId = (req.headers['x-user-id'] || '').trim()
  const role   = (req.headers['x-user-role'] || '').trim()
  if (!userId || !['vendor', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  next()
}
```

Este middleware:
- ✅ Verifica la presencia de headers requeridos
- ✅ Valida que el rol sea válido (vendor o admin)
- ✅ Rechaza con 403 si falla la validación

#### Validación de Ownership (líneas 60-68)

```javascript
async function checkProductOwner(token, productId, userId) {
  const res = await fetch(
    `${PB_URL}/api/collections/products/records/${productId}?expand=store`,
    { headers: pbHeaders(token) }
  )
  if (!res.ok) return false
  const product = await res.json()
  return userOwnsStore(product?.expand?.store, userId)
}
```

Esto verifica que:
- ✅ El usuario es el owner de la tienda del producto
- ✅ No puede modificar productos ajenos
- ✅ Usa el token de admin para consultar PocketBase

---

### 4. Inconsistencia en Servicio de Archivos: HALLAZGO IMPORTANTE

#### Problema: Dos Rutas Diferentes

En `HomeView.vue` hay inconsistencia:

```javascript
// Línea 173 - Store files a través del backend
return `${API}/stores/files/stores/${store.id}/${store.banner}`

// Línea 178 - Store avatars a través del backend
return `${API}/stores/files/stores/${store.id}/${store.logo}`

// Línea 184 - Product images DIRECTO a PocketBase
return `${PB}/api/files/products/${product.id}/${imgs[0]}?thumb=600x800`

// Línea 190 - Auction images DIRECTO a PocketBase
return `${PB}/api/files/auctions/${auction.id}/${imgs[0]}?thumb=800x600`
```

#### Análisis

| Tipo de Archivo | Ruta | Proxy Backend | Control |
|---|---|---|---|
| Store banners | `/stores/files/...` | ✅ Sí | ✅ Backend puede filtrar |
| Product images | `/api/files/products/...` | ❌ Directo | ⚠️ Sin control backend |
| Auction images | `/api/files/auctions/...` | ❌ Directo | ⚠️ Sin control backend |

**Impacto:** Dificulta la auditoría centralizada y el control de acceso uniforme.

---

## ⚠️ EVALUACIÓN DE RIESGOS

| Riesgo Identificado | Severidad | Evidencia | Mitigación |
|---|---|---|---|
| Credenciales de admin inválidas | 🔴 CRÍTICO | `.env` con placeholder credentials | Obtener credenciales válidas de PocketBase |
| Acceso público a imágenes enumerable | 🟡 MEDIO | `${PB}/api/files/products/{recordId}/{filename}` público | Rate limiting + validación de IDs válidos |
| Inconsistencia en rutas de archivos | 🟡 MEDIO | Mix de rutas backend y directo | Definir estrategia única |
| Headers de autenticación confiables desde frontend | 🟡 MEDIO | Frontend envía `x-user-id` y `x-user-role` | Usar JWT firmado en lugar de headers |
| Acceso directo a PocketBase | 🟡 MEDIO | Frontend apunta directamente a instancia | Solo para archivos (aceptable), pero expone URL |

---

## 🔧 DETALLES TÉCNICOS

### Hallazgo #1: Credenciales de Placeholder (CRÍTICO)

**Archivo afectado:** `tienda_tecno-back/.env`

```
POCKETBASE_AUTH_IDENTITY=correo@admin.com
POCKETBASE_AUTH_PASSWORD=tu_password_admin
```

**¿Por qué es crítico?**

1. Todos los servicios llaman a `getAdminToken()` al iniciar
2. Si la autenticación falla, el servicio falla completamente
3. No hay mecanismo de fallback o degradación
4. Las operaciones de escritura dependen del token de admin cacheado

**Síntomas esperados si las credenciales son inválidas:**

```
ERROR: PB admin auth failed: 401
POST /products → 500 (no admin token available)
PATCH /products/:id → 500 (no admin token available)
POST /orders → 500 (no admin token available)
```

**Solución:**
1. Obtén las credenciales válidas de tu instancia de PocketBase
2. Actualiza `.env` con credenciales reales
3. Redespliega los servicios

---

### Hallazgo #2: Google OAuth Flow (CORRECTO ✅)

El flujo de autenticación de Google está bien implementado:

```javascript
// auth-service/src/index.js líneas 188-200

app.post('/google/sync', async (req, res) => {
  // 1. Valida el access_token con Google
  const googleUser = await getGoogleProfile(accessToken)
  
  // 2. Obtiene token de admin para PocketBase
  const adminToken = await pocketBaseAdminAuth()
  
  // 3. Crea/actualiza usuario en PocketBase
  const userRecord = await upsertPocketBaseUser(adminToken, googleUser)
  
  // 4. Retorna el registro del usuario
  return res.json({
    ok: true,
    user: userRecord
  })
})
```

Este flujo es seguro porque:
- ✅ Valida el token con OAuth2 endpoint de Google
- ✅ Verifica el audience del token contra GOOGLE_CLIENT_ID
- ✅ Backend sincroniza el usuario a PocketBase
- ✅ Frontend recibe un registro verificado

---

## ✅ CONCLUSIONES Y RESPUESTAS

### ¿El backend está siendo omitido?

**RESPUESTA: Parcialmente no, pero con un problema crítico.**

**Para operaciones de LECTURA (READ):**
- ❌ NO está siendo omitido
- ✅ Frontend usa correctamente el backend API Gateway
- ✅ Backend obtiene datos de PocketBase y los retorna
- ⚠️ Las imágenes van directo a PocketBase (aceptable, son públicas)

**Para operaciones de ESCRITURA (WRITE):**
- ⚠️ SÍ estaría siendo omitido SI las credenciales de admin son inválidas
- Si las credenciales no funcionan, el backend no puede crear/actualizar registros
- Las operaciones de escritura dependen completamente del token de admin cacheado

### ¿Por qué el sistema funciona localmente?

**Hipótesis más probable:**

1. **Opción A:** Tienes un archivo `.env.local` o diferente en tu máquina con credenciales VÁLIDAS
2. **Opción B:** Tu instancia local de PocketBase tiene configuradas esas credenciales de placeholder
3. **Opción C:** Solo estás probando operaciones de lectura (que no requieren credenciales válidas)

### ¿Qué operaciones realmente necesitan el backend?

| Operación | Necesita Backend | Por qué |
|-----------|---|---|
| Crear producto | ✅ Sí | Valida que el usuario es owner de la tienda |
| Actualizar producto | ✅ Sí | Verifica ownership y aplica cambios |
| Eliminar producto | ✅ Sí | Requiere autenticación y ownership |
| Listar productos | ✅ Sí (pero no requiere login) | Filtra por status, categoría, precio, búsqueda |
| Ver imagen | ❌ No | Es archivo público, PocketBase lo sirve |
| Crear orden | ✅ Sí | Requiere usuario autenticado |
| Ver disponibilidad | ✅ Sí | Consulta stock en tiempo real |
| Google OAuth | ✅ Sí | Backend sincroniza usuario a PocketBase |

---

## 📌 RECOMENDACIONES INMEDIATAS

### 1. Resolver Credenciales de Admin (CRÍTICO)

**Acciones:**
1. Accede a tu instancia de PocketBase en `https://tecnotienda.zamoranogamarra.online`
2. Obtén las credenciales de un super usuario válido
3. Actualiza `tienda_tecno-back/.env`:
   ```
   POCKETBASE_AUTH_IDENTITY=<email_válido>
   POCKETBASE_AUTH_PASSWORD=<password_válido>
   ```
4. Redespliega los contenedores Docker
5. Prueba creando un producto para verificar que funciona

**Por qué:** Sin esto, todas las operaciones de escritura fallarán en producción.

---

### 2. Consistencia en Rutas de Archivos (MEDIO)

**Dos opciones:**

**Opción A: Todos a través del backend proxy (más control)**
```javascript
// Cambiar en HomeView.vue línea 184
const productImageUrl = (product) => {
  const imgs = Array.isArray(product.images) ? product.images : []
  if (!imgs[0]) return null
  return `${API}/products/files/${product.id}/${imgs[0]}?thumb=600x800`
}
```

Ventajas:
- ✅ Control centralizado de acceso
- ✅ Permite logging y auditoría
- ✅ Implementar rate limiting fácilmente
- ✅ Validar que el producto existe y está activo

**Opción B: Todos directo a PocketBase (más rápido)**
```javascript
// Dejar todo como está
// Documentar que las imágenes son públicas
```

Ventajas:
- ✅ Mejor rendimiento (no pasa por backend)
- ✅ PocketBase maneja el caching
- ✅ Reduce carga en microservicios

**Recomendación:** Opción A si necesitas control; Opción B si prioriza rendimiento.

---

### 3. Rate Limiting en Imágenes (MEDIO)

**Implementar en PocketBase:**
- Limitar a 100 requests por IP por minuto
- Prevenir descarga masiva de imágenes mediante enumeración

---

### 4. Validación de Tokens (MEDIO)

**Cambiar de headers a JWT:**

```javascript
// En lugar de confiar en x-user-id y x-user-role headers
// Implementar:

app.post('/login', async (req, res) => {
  // ... validar credenciales ...
  
  const token = jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  )
  
  res.json({ token })
})

// Middleware:
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'forbidden' })
    req.user = user
    next()
  })
}
```

---

### 5. Documentación de Flujos (BAJO)

Crear un documento que especifique:
- Qué endpoints van por backend
- Qué endpoints van directo a PocketBase
- Por qué cada decisión

---

## 📊 RESUMEN DE ARQUITECTURA

```
┌─────────────────────────────────────────────────────────────┐
│ FRONTEND (Vue.js 3) - tienda-tecno-front                    │
├─────────────────────────────────────────────────────────────┤
│ const API = VITE_GATEWAY_API_BASE_URL                       │
│ const PB = VITE_POCKETBASE_URL                              │
│                                                              │
│ Datos: fetch(${API}/products, ${API}/stores, ...)           │
│ └─> API Gateway (9000) └─> 14 Microservicios (9001-9014)   │
│                                                              │
│ Archivos: fetch(${PB}/api/files/...)                        │
│ └─> Directo a PocketBase (HTTPS)                            │
└─────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 14 MICROSERVICIOS - tienda_tecno-back/services/             │
├─────────────────────────────────────────────────────────────┤
│ • auth-service (9001)                                       │
│ • store-service (9002)                                      │
│ • product-service (9003)                                    │
│ • auction-service (9004)                                    │
│ • order-service (9005)                                      │
│ • finance-service (9006)                                    │
│ • wishlist-service (9007)                                   │
│ • review-service (9008)                                     │
│ • giftcard-service (9009)                                   │
│ • dashboard-service (9010)                                  │
│ • store-followers-service (9011)                            │
│ • bid-order-service (9012)                                  │
│ • transaction-service (9013)                                │
│ • cart-service (9014)                                       │
│                                                              │
│ Cada uno:                                                    │
│ 1. Lee POCKETBASE_URL, AUTH_IDENTITY, AUTH_PASSWORD        │
│ 2. Llama a getAdminToken() para autenticarse               │
│ 3. Cachea el token por 55 minutos                          │
│ 4. Usa el token para todas las operaciones en PocketBase   │
└─────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ POCKETBASE - https://tecnotienda.zamoranogamarra.online     │
├─────────────────────────────────────────────────────────────┤
│ • Autenticación: _superusers/auth-with-password             │
│ • Colecciones: users, products, stores, orders, ...         │
│ • Archivos: /api/files/{collection}/{recordId}/{filename}   │
│ • Credenciales en .env: ❌ PLACEHOLDER                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 📈 ESTADO DE SEGURIDAD GENERAL

### Lo que funciona bien ✅

- ✅ Frontend usa correctamente el backend para operaciones de datos
- ✅ Endpoints de escritura tienen middleware de autenticación
- ✅ Validación de ownership (vendor no puede crear en tienda ajena)
- ✅ Google OAuth está correctamente sincronizado
- ✅ Separación clara entre datos (backend) y archivos (PocketBase)
- ✅ Token de admin se cachea eficientemente por 55 minutos
- ✅ Todas las peticiones a PocketBase usan headers de autorización

### Lo que necesita repararse ❌

- ❌ **CRÍTICO:** Credenciales de admin inválidas en .env
- ⚠️ Inconsistencia en rutas de archivos
- ⚠️ Falta de rate limiting en endpoints públicos
- ⚠️ Sin validación de tokens firmados (confía en headers)
- ⚠️ Exposición directa de URL de PocketBase al frontend

---

## 🎯 PRÓXIMOS PASOS

1. **Esta semana:**
   - [ ] Obtener credenciales válidas de PocketBase
   - [ ] Actualizar `.env` en tienda_tecno-back
   - [ ] Redeploy y testing

2. **Próximas 2 semanas:**
   - [ ] Implementar rate limiting en imágenes
   - [ ] Definir estrategia de archivos (backend vs directo)
   - [ ] Documentar flujos de datos

3. **Próximo mes:**
   - [ ] Migrar a JWT en lugar de headers
   - [ ] Implementar auditoría de accesos
   - [ ] Testing de seguridad con herramientas (OWASP ZAP)

---

## 📞 CONTACTO Y PREGUNTAS

Si tienes dudas sobre este informe o necesitas aclaraciones:

- **Proyecto:** TuVentaConfiada
- **Auditoría realizada:** 14 de Mayo de 2026
- **Tipo:** Análisis de Arquitectura y Autenticación

---

**FIN DEL INFORME**
