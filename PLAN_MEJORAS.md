# Plan de Mejoras — BeerPOS

Propuesta de mejoras para la app de gestión de bar/licorería. Organizado por categorías, prioridad y complejidad.

---

## 1. Pantalla de Cliente (QR / PWA)

### 1.1 Modo pantalla completa / PWA instalable
- Agregar `manifest.webmanifest` con `display: standalone`
- Service Worker para funcionar offline y cachear assets
- Botón "Agregar a la pantalla de inicio" en vista cliente

### 1.2 Historial de compras del cliente
- Endpoint `GET /api/clients/:id/history` con transacciones pasadas
- Tabla en vista cliente: fecha, cantidad, monto USD/VES
- Filtro por rango de fechas

### 1.3 Saldo en tiempo real sin recargar
- Ya implementado vía Socket.io + SSE, pero reforzar con polling cada 10s como red de seguridad final

---

## 2. Panel del Bartender / Admin

### 2.1 Panel de control (Dashboard)
- Tarjetas resumen: ventas del día, clientes activos, saldo total en cervezas, pendientes
- Gráfico de ventas por hora/día (Chart.js o Canvas)
- Top 5 clientes por volumen de compra

### 2.2 Gestión de inventario
- Registro de stock de cervezas (cajas, botellas)
- Alerta cuando stock bajo (umbral configurable)
- Historial de entradas/salidas de inventario

### 2.3 Gestión de staff
- CRUD de bartenders con roles (admin, bartender, cajero)
- PIN de acceso individual por staff
- Log de acciones: quién aceptó/entregó cada pedido

### 2.4 Cierre de caja (Z-report)
- Reporte diario: total vendido, total en efectivo, total en transferencia, diferencia
- Botón "Cerrar caja" que bloquea el día y genera PDF
- Historial de cierres

---

## 3. Reportes y Exportación

### 3.1 Exportar a Excel (.xlsx) y PDF
- Librería `xlsx` para Excel, `jspdf` para PDF
- Botones en pestaña Reportes: CSV, Excel, PDF
- Incluir logo del establecimiento en PDF

### 3.2 Reportes programados
- Envío automático de reporte diario por WhatsApp/Email al dueño
- Configuración de destinatario y hora

### 3.3 Filtros avanzados en reportes
- Filtrar por bartender, tipo de transacción, rango de fechas, cliente
- Comparar período actual vs período anterior

---

## 4. Clientes y Fidelidad

### 4.1 Programa de lealtad
- Puntos por compra (1 punto por cerveza)
- Canje de puntos por cervezas gratis
- Niveles de cliente (Bronce, Plata, Oro) con descuentos

### 4.2 Clientes morosos / saldo negativo
- Permitir saldo negativo con límite configurable
- Lista de clientes con saldo pendiente
- Notificación al dueño cuando un cliente supera el límite

### 4.3 Búsqueda y etiquetado
- Etiquetas/tags para clientes (VIP, frecuente, moroso)
- Filtro rápido por etiqueta en panel de bartender

---

## 5. Seguridad y Estabilidad

### 5.1 Autenticación reforzada
- 2FA (autenticación de dos factores) para admin
- Bloqueo de cuenta tras 3 intentos fallidos de PIN
- Expiración de sesiones de staff configurable

### 5.2 Auditoría de acciones
- Tabla `audit_log`: usuario, acción, entidad, fecha, IP
- Endpoint `GET /api/audit` para revisar historial

### 5.3 Rate limiting y DDoS
- Límites por IP y por usuario en endpoints críticos (login, redeem, fast-sale)
- Protección contra fuerza bruta en PIN

### 5.4 Backup automático
- Exportar base de datos a JSON/CSV diariamente
- Almacenar en cloud o enviar por email

### 5.5 Validación de entrada
- Sanitizar todos los inputs (XSS, SQL injection ya mitigado por pg params)
- Validar rangos de cantidad, montos negativos, fechas

---

## 6. Notificaciones y Comunicación

### 6.1 Notificaciones push (PWA)
- Push al cliente cuando su pedido esté listo
- Push al bartender cuando haya nuevo pedido

### 6.2 WhatsApp Business API
- Enviar QR de cliente por WhatsApp al registrarse
- Notificar entrega de pedido por WhatsApp
- Plantillas de mensaje personalizables

### 6.3 Email de reportes
- Envío de reporte diario al dueño del negocio
- Configuración SMTP (host, puerto, usuario, contraseña)

---

## 7. Experiencia de Usuario (UX/UI)

### 7.1 Modo oscuro/claro
- Toggle de tema en ajustes
- Colores personalizables por establecimiento

### 7.2 Impresión térmica
- Imprimir ticket de venta en impresora térmica (USB/Bluetooth)
- Formato compacto para tickets de 58mm o 80mm

### 7.3 Teclado numérico en pantalla
- Para dispositivos touch sin teclado físico
- Entrada rápida de PIN y cantidades

### 7.4 Idiomas
- Español (predeterminado) e Inglés
- Selector de idioma en login y ajustes

---

## 8. Base de Datos y Rendimiento

### 8.1 Índices de optimización
- Índices en `transactions(establishment_id, created_at)`
- Índices en `client_orders(establishment_id, status)`
- Índices en `clients(access_token, establishment_id)`

### 8.2 Particionamiento por fecha
- Particionar `transactions` por mes para consultas rápidas en reportes históricos

### 8.3 Caché de consultas frecuentes
- Redis para cachear saldo de clientes, establecimiento, tasa BCV
- Reducir carga en PostgreSQL

---

## 9. Despliegue y Operaciones

### 9.1 Docker
- `Dockerfile` para backend y frontend
- `docker-compose.yml` para levantar todo con PostgreSQL y Redis
- Variables de entorno en `.env`

### 9.2 HTTPS y dominio
- Certificado SSL (Let's Encrypt)
- Configuración de dominio propio por cliente

### 9.3 Monitoreo y salud
- Endpoint `/api/health` con detalle de DB, Redis, Socket.io
- Métricas básicas: conexiones activas, tiempo de respuesta

---

## Prioridad sugerida para implementación

| Fase | Área | Elementos clave | Estimado |
|------|------|-----------------|----------|
| 1 | Seguridad | Auditoría, 2FA, rate limiting, backup | 1 semana |
| 2 | UX | PWA, modo oscuro, impresión térmica | 1 semana |
| 3 | Reportes | Exportar Excel/PDF, filtros avanzados | 1 semana |
| 4 | Clientes | Historial, lealtad, WhatsApp | 1.5 semanas |
| 5 | Admin | Dashboard, gestión staff, cierre de caja | 2 semanas |
| 6 | Operaciones | Docker, monitoreo, HTTPS | 1 semana |

---

¿Quieres que implemente alguna de estas fases o prefieres ajustar prioridades antes de empezar?