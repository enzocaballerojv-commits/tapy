# Sistema de redirect + contador + panel — fichas NFC

IMPORTANTE: Cloudflare cambió su forma de crear proyectos desde Git.
Ya no se llama "Pages" para lo que estás haciendo — tu proyecto quedó
creado como un **Worker** (así se ve en tu dashboard: `tapy`). Este
código está adaptado a ese modelo. La carpeta `functions/` que
usábamos antes ya NO se usa — todo vive en un solo archivo:
`src/index.js`.

## Estructura del proyecto

```
/
├── README.md
├── schema.sql
├── schema_settings.sql
├── wrangler.toml
├── src/
│   └── index.js       <- todo el backend: redirect, contador, y la API del panel
└── public/
    ├── error.html
    └── panel.html
```

## Punto clave que causó el error que viste

Tu Worker en el dashboard se llama **`tapy`**. El `wrangler.toml` tiene
que decir exactamente ese mismo nombre en el campo `name`, sino
Cloudflare rechaza el deploy. Ya está corregido en este archivo.

## Pasos para desplegar

### 1. Crear la base de datos D1 (si todavía no la creaste)
Dashboard → Workers & Pages → D1 → Create database → nombrala
`nfc-negocio-db`. Copiá el `database_id` que te muestra y pegalo en
`wrangler.toml`, reemplazando `PEGAR_AQUI_EL_ID_QUE_TE_DA_CLOUDFLARE`.

### 2. Cargar el esquema
En el Query Editor de esa base D1: ejecutá `schema.sql` completo — si
la consola solo corre lo que está seleccionado, seleccioná manualmente
TODO el texto (Ctrl+A) antes de apretar Run. Confirmá en el panel
izquierdo que aparezcan las 3 tablas: `clients`, `chips`, `taps`.
Después ejecutá `schema_settings.sql` de la misma forma (crea la tabla
`settings` con los valores iniciales).

### 3. Configurar la contraseña del panel
En tu Worker (`tapy`) → Settings → Environment variables → agregá
`PANEL_PASSWORD` con la contraseña que quieras.

### 4. Subir estos archivos al repositorio
Reemplazá todo el contenido del repo por esta versión (borrá la
carpeta `functions/` si seguía en GitHub, agregá `src/index.js`).
Hacé commit y push — esto dispara un nuevo build automático.dfsfsdf
   
### 5. Confirmar el binding de D1
En el Worker → Settings → Bindings (o Variables) → confirmá que exista
un binding de tipo D1 llamado `DB` apuntando a `nfc-negocio-db`. Si no
aparece solo porque está en el `wrangler.toml`, agregalo también manual
desde ahí — con integraciones Git a veces hace falta declararlo en
los dos lugares.

### 6. Ver el deploy
Volvé a la pestaña Deployments — el build debería pasar por
Initializing → Cloning → Installing → Deploying, los cuatro en verde.

## Cómo probar

- Panel: `https://tapy.<tu-subdominio>.workers.dev/panel.html`
- Redirect de un chip: `https://tapy.<tu-subdominio>.workers.dev/c/slug-de-prueba`

(La URL exacta con tu subdominio te la muestra el dashboard en la
pestaña Overview de tu Worker.)

## Dar de alta tu primer cliente y chip de prueba

Podés hacerlo directo desde el panel (pestaña Clientes) una vez que
entres con la contraseña — ya no hace falta escribir SQL a mano para
esto.

## Cómo funciona cada pestaña del panel

- **Clientes** — alta de comercios y de sus chips. Calcula sola la
  fecha del primer reporte (regla de los días 7 y 22). Los botones
  Activar/Suspender cambian el estado, que es lo que hace que el
  redirect del chip vaya al destino real o a la página neutra.
- **Cobros** — ordenado por vencimiento. Botón de WhatsApp con mensaje
  pre-armado (vencimiento + tu alias). "Marcar pagado" reactiva y
  corre el vencimiento un mes o un año según el plan.
- **Reportes** — solo lista clientes cuyo próximo reporte es hoy o
  antes, con el conteo real de toques del período. "Marcar enviado"
  calcula la próxima fecha automáticamente.
- **Inventario** — chips comprados, asignados (contados solos),
  disponibles, y tu alias bancario.

## Advertencias que ya te había hecho y siguen aplicando

- La contraseña del panel es simple (una sola clave compartida) — está
  bien para esta etapa, pero no es a prueba de un equipo grande.
  Cloudflare Access es el upgrade natural el día que haga falta.
- El cálculo de "reporte el 30" tiene un detalle raro en febrero por
  cómo JavaScript maneja fechas fuera de rango — revisalo a mano ese
  mes puntual cuando llegue, no vale la pena resolverlo de más ahora.

## Qué falta después de esto

- Cargar tu primer cliente real y su primer chip cuando llegue en 10 días.
- Ajustar los mensajes de WhatsApp a tu gusto — están en `panel.html`,
  buscá la palabra `mensaje`.
- Comprar el dominio más adelante y reemplazar la URL de `workers.dev`
  por la definitiva en `src/index.js` y `panel.html`.
