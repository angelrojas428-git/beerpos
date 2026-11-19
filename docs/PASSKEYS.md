# Passkeys y autenticación de clientes

BeerPOS usa WebAuthn/FIDO2 para registrar y verificar passkeys. El navegador o sistema operativo ofrece el autenticador disponible: huella, reconocimiento facial, Windows Hello, PIN del dispositivo o una llave de seguridad compatible. BeerPOS nunca recibe ni almacena una huella o plantilla biométrica; almacena la credencial de clave pública y su contador de uso.

## Uso

- El cliente abre su enlace/QR en un navegador compatible y por HTTPS, y selecciona **Activar** en “Acceso con passkey”.
- Después de vincular una passkey, cada retiro solicitado desde ese enlace requiere una autenticación con verificación de usuario. Clientes sin passkey conservan el flujo actual.
- El código temporal que se muestra al bartender sigue siendo necesario para confirmar la entrega.
- En el POS, el botón **Passkey cliente** autentica una credencial discoverable y crea la solicitud de una cerveza, igual que el botón anterior.
- La autorización del retiro es de un solo uso, caduca rápidamente y queda ligada al cliente, establecimiento y cantidad autenticada.
- El cliente puede añadir más de una passkey y quitar una tras autenticarse con otra. Si pierde todos sus autenticadores, el propietario del establecimiento puede restablecer las passkeys desde la ficha del cliente; el cliente deberá volver a registrarse desde su enlace/QR.

## Compatibilidad de lectores

Windows Hello y los autenticadores de plataforma de teléfonos/tablets funcionan a través de WebAuthn cuando el navegador y el sistema los ofrecen. Una llave o lector USB debe soportar FIDO2/WebAuthn y credenciales discoverable (passkeys). Un lector de huellas genérico o propietario que requiere un SDK/controlador especial no puede ser usado directamente por esta aplicación web.

La disponibilidad de autenticación entre dispositivos —por ejemplo, usar un teléfono para responder a una solicitud iniciada en el POS— depende del navegador, sistema operativo y autenticador.

## Despliegue y datos existentes

Las tablas de credenciales, retos de corta duración y autorizaciones de un solo uso se crean con `db/schema.sql` durante el bootstrap habitual. En producción, el origen debe ser HTTPS y estar autorizado por `CORS_ORIGIN` o `RENDER_EXTERNAL_URL`.

Los registros de `client_fingerprints` se conservan sin cambios, pero ya no son consultados por rutas activas. `FINGERPRINT_ENCRYPTION_KEY` queda como clave heredada para que esos datos cifrados puedan recuperarse si hiciera falta; las passkeys no dependen de ella.
