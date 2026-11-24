# Vacaciones del bar

Aplicación web para organizar las vacaciones anuales del equipo (cocina y camareros, turnos de mañana y tarde) respetando siempre la cobertura mínima de cada día.

## Puesta en marcha

Requisitos: Node.js 22 o superior.

```bash
npm install
npm run build      # compila la interfaz
npm start          # http://localhost:3000
```

La primera vez se crea la base de datos `data/vacaciones.db` (SQLite) con los 12 trabajadores de ejemplo.

- Administrador: usuario `admin`, contraseña `admin`, salvo que antes del primer arranque pongas las variables `ADMIN_USERNAME` y `ADMIN_PASSWORD`. **Cámbiala nada más entrar.**
- Trabajadores: usuario = nombre en minúsculas sin acentos (`lucia`, `javier`, `marta`…), contraseña `1234`. Se cambian desde «Equipo».

Variables de entorno: `PORT` (puerto), `DB_FILE` (ruta de la base de datos), `ADMIN_USERNAME`, `ADMIN_PASSWORD`.

## Versión de prueba sin servidor

`npm run build` genera también `dist-demo/vacaciones-demo.html`: un único archivo que funciona abriéndolo en el navegador. Usa exactamente las mismas reglas y el mismo generador, pero guarda los datos solo en ese navegador. Sirve para probar, no para usar con el equipo.

## Pruebas

```bash
npm test
```

Comprueban los ejemplos de conflictos, los suplentes, que el generador da 30 días a todos sin conflictos (con y sin suplentes, años normales y bisiestos) y el flujo completo de solicitudes e intercambios.

## Cómo está hecho

- `shared/rules.js`: reglas de cobertura. Se ejecutan en el navegador (avisos en tiempo real) y en el servidor (validación definitiva). Ningún cambio que deje un turno por debajo del mínimo se guarda, tampoco desde el panel de administración.
- `shared/generator.js`: generador de propuestas.
- `shared/service.js`: lógica de la aplicación (usuarios, permisos, solicitudes, historial, notificaciones).
- `server/`: servidor Express + SQLite (`node:sqlite`, sin dependencias nativas).
- `web/`: interfaz (Preact), exportación a Excel y PDF.

## Desplegar

Cualquier servicio que ejecute Node 22 con un disco persistente para `data/` sirve (Render, Railway, Fly.io, un VPS…). Comando de compilación `npm install && npm run build`, comando de arranque `npm start`. Hay que montar un volumen persistente en `data/` (o fijar `DB_FILE`) para no perder datos.
