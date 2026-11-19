# Manual de Usuario — BeerPOS

## 1. Introducción
BeerPOS es un sistema de gestión para bares/licorerías: clientes con QR, inventario de cervezas, ventas, créditos (fiado), caja, reportes, impresión térmica y panel administrativo.

## 2. Requisitos
### Clientes (usuarios finales)
- Navegador moderno (Chrome/Edge/Safari) o app PWA instalable.
- Conexión a internet (o red local del establecimiento).
- QR del cliente (impreso o en pantalla).
### Administradores / operadores
- Node.js 18+ y PostgreSQL 14+ (o Docker).
- Variables de entorno configuradas (.env): DATABASE_URL, JWT/SESSION secret, CORS origin, RENDER_EXTERNAL_URL (si aplica).
- Navegador para panel admin; impresora térmica 58/80mm opcional.

## 3. Acceso
1. Abrir la URL del sistema.
2. Iniciar sesión con credenciales de staff (admin/bartender/cajero) o PIN.
3. Seleccionar establecimiento si aplica.

## 4. Gestión de clientes
- Registrar cliente: nombre, documento, teléfono → genera QR único.
- Consultar saldo de cervezas y historial de compras.
- Recargar saldo (compra de cervezas) y canjear (redención).
- Crédito/fiado: límite configurable, lista de morosos.
- Programa de lealtad: puntos por compra, niveles bronce/plata/oro.

## 5. Ventas y pedidos
- Venta rápida por QR o búsqueda de cliente.
- Combo purchase (cargo de cervezas con pago).
- Pedidos de clientes (client orders) con estados.
- Impresión de ticket térmico (58/80mm) con auto-impresión opcional.

## 6. Inventario
- Stock de cervezas (cajas/botellas).
- Auto-decremento al vender.
- Alertas de stock bajo (umbral configurable).
- Historial de entradas/salidas.

## 7. Caja
- Abrir/cerrar turno.
- Esperado vs contado, diferencia.
- Historial de cierres (Z-report).

## 8. Reportes
- Ventas por día/hora, top clientes, desglose diario.
- Filtros por fecha, bartender, tipo, cliente.
- Exportar a CSV, Excel (.xlsx) y PDF.
- Auditoría de acciones.

## 9. Administración
- Gestión de staff (roles, PIN, bloqueo por intentos).
- Configuración de establecimiento (precio cerveza, tema, logo).
- Plataforma (super-admin): onboarding, suscripciones, backup JSON.

## 10. PWA y offline
- Instalar como app (Agregar a pantalla de inicio).
- Service worker cachea assets; funciona offline parcialmente.

## 11. Seguridad
- Rate limiting en login/redeem/fast-sale.
- Sesiones con expiración configurable.
- 2FA para admin (si habilitado).
- Auditoría de acciones con IP.

## 12. Despliegue
- Docker Compose con PostgreSQL y Redis.
- HTTPS con certificado SSL.
- Endpoint /api/health para monitoreo.
- Backup automático recomendado (export JSON diario).

## 13. Soporte
- Revisar logs del backend.
- Verificar conectividad DB (health/live).
- Contactar administrador de plataforma para incidencias.
