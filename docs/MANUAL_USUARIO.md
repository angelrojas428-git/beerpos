# Manual de Usuario — BeerPOS

Guía para operar BeerPOS en el día a día: alta del comercio, operación diaria en la barra y cierre de caja. Está escrito para el **dueño/administrador** del comercio y el **bartender**.

---

## 1. Requisitos

- La app se abre en el navegador: `https://TU-DOMINIO` (PC, tablet o celular).
- Cada persona que opera ingresa con **usuario + PIN**.
- Recomendado: anclar la app a la pantalla de inicio (es una PWA) y usarla en modo pantalla completa.

---

## 2. Alta del comercio (solo la primera vez)

El alta del comercio la realiza el **equipo de BeerPOS** desde la consola de super-admin (`/admin.html`). El dueño solo necesita:

1. Elegir un **nombre de comercio**.
2. Definir el **nombre del dueño** y un **PIN** (6 a 12 dígitos, solo números).
3. Indicar el **precio de la cerveza** (en USD) y, si se cobra en bolívares, la **tasa de cambio** inicial (USD→VES).
4. (Opcional) **logo** y **colores** de la marca.

Una vez creado el comercio, el dueño recibe su usuario y PIN y ya puede entrar.

> El alta crea automáticamente: el comercio, el usuario dueño (rol `owner`) y la tasa de cambio. No hay que tocar la base de datos.

### 2.1 Agregar más personal (bartenders)

Desde la pantalla de barra, el **dueño** puede crear usuarios adicionales (rol `bartender` o `cashier`), cada uno con su PIN. Así cada quien entra con su propio acceso y las acciones quedan registradas.

### 2.2 Activar 2FA (recomendado para el dueño)

En el perfil, el dueño puede activar **2FA (TOTP)**: además del PIN, se pide un código de 6 dígitos de una app autenticadora (Google Authenticator, Authy, etc.). Escanea el QR que muestra la app y guarda los códigos de respaldo.

---

## 3. Operación diaria en la barra

### 3.1 Iniciar sesión

1. Abre `https://TU-DOMINIO`.
2. Selecciona el comercio (si hay más de uno) e ingresa **usuario + PIN**.
3. Si tienes 2FA activado, ingresa el código de la app autenticadora.

### 3.2 Registrar una venta / cobrar

- **Venta rápida (código de 3 dígitos):** el bartender genera un código corto, el cliente lo dicta y se cobra al instante. El código **expira** a los pocos minutos (configurable) para evitar fraudes.
- **Venta a cliente con saldo (QR):** el cliente presenta su **QR**; el bartender lo lee y descuenta el saldo prepagado del cliente. Si el saldo es insuficiente, la app lo rechaza.
- **Métodos de pago:** efectivo, pago móvil, transferencia, Zelle, etc. (se registra el método en cada transacción).

### 3.3 Pedidos de clientes (QR)

Los clientes pueden hacer pedidos desde su celular (escaneando su QR). El pedido llega a la pantalla de la barra como **SOLICITADO**. El bartender:

1. **Acepta** el pedido (pasa a EN PREPARACIÓN).
2. Al entregarlo, lo marca como **ENTREGADO** (se descuenta el saldo).

Los pedidos que no se atienden a tiempo **expiran** automáticamente (por cron, cada 5 min).

### 3.4 Clientes

- **Registrar cliente:** nombre, documento y teléfono. El sistema genera un **QR** (token) que se entrega al cliente una sola vez. Guárdalo o imprímelo.
- **Rotar QR:** si un QR se ve comprometido, el soporte puede **rotar el token** (genera uno nuevo; el anterior deja de servir).

### 3.5 Tiempo real

Los cambios (nuevos pedidos, canjes, vencimientos) aparecen **en vivo** en la pantalla de la barra (Socket.io/SSE), sin recargar.

---

## 4. Cierre de caja

1. Ve a **Reportes** y selecciona el rango de fechas (normalmente el día actual).
2. Revisa el **resumen**: total de ventas, por método de pago, por tipo de transacción y saldo de clientes.
3. **Exporta** el reporte a Excel, CSV o PDF para tu control contable.
4. Verifica que el **efectivo** y los **pagos digitales** cuadren con lo registrado.
5. Deja constancia de la **tasa de cambio** usada si cobraste en bolívares.

> Los reportes y exportaciones están protegidos: solo los roles autorizados (dueño/administrador) pueden descargarlos.

---

## 5. Usuarios y seguridad

- **PIN:** 6 a 12 dígitos. No lo compartas. Cada persona con su propio PIN.
- **Bloqueo por intentos:** tras varios intentos fallidos, la cuenta se bloquea temporalmente (15 min).
- **2FA:** actívalo para el dueño y roles sensibles.
- **Cerrar sesión:** al terminar el turno, usa **Salir** para invalidar la sesión.
- **Forzar logout (soporte):** si sospechas que una sesión sigue abierta, el soporte puede **revocar todas las sesiones** de tu comercio; el personal deberá iniciar sesión de nuevo.

---

## 6. Suscripción y pagos

BeerPOS funciona por **suscripción mensual por comercio**, con planes (Gratis, Pro, Business, Enterprise). El ciclo es automático:

- **Activo:** el servicio funciona con normalidad.
- **Vencido / impago:** tras el período de gracia, el comercio se **suspende automáticamente** y el personal no puede iniciar sesión hasta ponerse al día.
- **Reactivación:** al registrar el pago, el comercio se reactiva al instante.

El pago se **verifica manualmente** por el equipo de BeerPOS (Pago Móvil, Zelle, transferencia, efectivo). Una vez confirmado, se extiende el período.

### 6.1 Pilotos / prueba gratuita

Los comercios nuevos pueden entrar como **piloto** (prueba gratuita de N días). Al vencer el piloto sin pago, el comercio se suspende automáticamente. El equipo puede extender el piloto o convertirlo en pago.

---

## 7. Soporte y feedback

- **Reportar un problema:** contacta al soporte por WhatsApp indicando tu comercio y una descripción.
- **Feedback del piloto:** el equipo registra tu valoración (1-5) y comentarios desde la consola para mejorar el producto.
- **Auditoría:** el sistema registra acciones críticas (logins, ventas, cambios) para trazabilidad y seguridad.

---

## 8. Preguntas frecuentes

**¿Se pierden los datos si se reinicia la app?**
No. Los datos viven en la base de datos (PostgreSQL) y los respaldos se guardan localmente y, si está configurado, en la nube (S3).

**¿Un cliente puede usar su QR en otro comercio?**
No. Cada QR pertenece a un comercio y solo funciona ahí.

**¿Qué pasa si un cliente no tiene saldo?**
La venta por QR se rechaza; puedes cobrar en efectivo/pago móvil o recargar su saldo.

**¿Cómo cambio la tasa de cambio?**
Desde la configuración del comercio (el dueño) o la actualiza el equipo. También se puede traer la tasa BCV automáticamente.

**¿Cuántos usuarios puedo tener?**
Depende del plan. El plan Gratis tiene límites (p. ej. 20 clientes); los planes superiores son más amplios.