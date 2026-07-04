# Sistema de redirect + contador para fichas NFC

Esto es la base técnica: cuando alguien toca un chip, este sistema decide
a dónde lo manda y cuenta el toque. No incluye todavía el panel de
administración (clientes, cobros, reportes) — eso es el siguiente paso,
una vez que esto esté funcionando y probado.

## Qué hace cada archivo

- `schema.sql` — crea las tablas `clients`, `chips` y `taps` en la base de datos.
- `functions/c/[slug].js` — la función que se ejecuta cada vez que alguien
  toca un chip. Busca el destino, registra el toque, redirige. Si algo
  falla en cualquier punto, manda a la página neutra en vez de mostrar
  un error — nunca deja al cliente final colgado.
- `public/error.html` — la página neutra (chip suspendido, mal
  configurado, o cualquier error inesperado).
- `wrangler.toml` — configuración para conectar el proyecto con la base
  de datos D1.

## Pasos para dejarlo funcionando

### 1. Crear el repositorio en GitHub
Subí esta carpeta completa a un repositorio nuevo en GitHub (puede ser privado).

### 2. Crear la base de datos D1 en Cloudflare
En el dashboard de Cloudflare, sección Workers & Pages → D1 → Create database.
Le pones un nombre, por ejemplo `nfc-negocio-db`.

Después de creada, Cloudflare te muestra un `database_id`. Copialo y
pegalo en `wrangler.toml`, reemplazando `PEGAR_AQUI_EL_ID_QUE_TE_DA_CLOUDFLARE`.

### 3. Cargar el esquema
Desde la consola/query editor de la base D1 en el dashboard de Cloudflare,
pegá y ejecutá todo el contenido de `schema.sql`. Esto crea las tres tablas.

### 4. Conectar el repositorio a Cloudflare Pages
En el dashboard: Workers & Pages → Create → Pages → Connect to Git →
elegís el repositorio que subiste. Dejás la configuración de build por
default (no hay build, son archivos estáticos + funciones).

### 5. Vincular la base de datos D1 al proyecto de Pages
En la configuración del proyecto de Pages ya creado: Settings → Functions →
D1 database bindings → Add binding.
- Variable name: `DB` (tiene que ser exactamente así, así se llama en el código)
- D1 database: elegís la que creaste en el paso 2

### 6. Volver a desplegar
Después de agregar el binding, hacé un nuevo deploy (podés simplemente
volver a subir/hacer push al repo, o usar el botón "Retry deployment").

## Cómo dar de alta tu primer chip de prueba (a mano, por ahora)

Todavía no hay panel, así que por ahora se hace directo en el query
editor de D1, ejecutando algo como esto:

```sql
INSERT INTO clients (name, business_type, whatsapp, signup_date, plan, status)
VALUES ('Panadería López', 'comercio', '+595...', '2026-07-03', 'basico', 'activo');

INSERT INTO chips (client_id, slug, label, destination_url, suspended_url)
VALUES (1, 'panaderia-lopez', 'Ficha mostrador', 'https://g.page/tu-link-de-resena', 'https://tuservicio.pages.dev/error.html');
```

Con esto, el link que grabás en el chip físico con NFC Tools es:

```
https://tuservicio.pages.dev/c/panaderia-lopez
```

Ese es el que va grabado y bloqueado con contraseña en el chip — nunca
el link final de Google Reviews.

## Cómo probarlo

Abrís esa URL en el navegador del celu. Tiene que redirigirte al link
de reseña casi al instante. Cada vez que lo abrís, se suma una fila en
la tabla `taps` — podés confirmarlo corriendo en el query editor:

```sql
SELECT * FROM taps;
```

## El panel de administración

Ya está incluido en `public/panel.html` + los archivos dentro de
`functions/api/`. Es un solo archivo HTML con pestañas: Clientes,
Cobros, Reportes, Inventario. Todo corre sobre la misma base D1.

### Estructura completa que tiene que quedar en el repo

```
/
├── README.md
├── schema.sql
├── schema_settings.sql
├── wrangler.toml
├── functions/
│   ├── _utils.js
│   ├── c/
│   │   └── [slug].js
│   └── api/
│       ├── _middleware.js
│       ├── login.js
│       ├── clients.js
│       ├── clients/
│       │   └── [id].js
│       ├── chips.js
│       ├── chips/
│       │   └── [id].js
│       ├── settings.js
│       └── reports/
│           └── due.js
└── public/
    ├── error.html
    └── panel.html
```

### Pasos extra para el panel

1. **Ejecutá también `schema_settings.sql`** en el query editor de D1
   (después de `schema.sql`). Esto crea la tabla de configuración con
   el inventario inicial (100 chips, USD 0,10 c/u) y un alias bancario
   de placeholder que después editás desde el panel.

2. **Configurá la contraseña del panel.** En el dashboard de Cloudflare:
   tu proyecto de Pages → Settings → Environment variables → agregá
   `PANEL_PASSWORD` con la contraseña que quieras usar. Sin esto, el
   panel no deja entrar a nadie (por diseño — mejor que se rompa cerrado
   que abierto).

3. **Volvé a desplegar** después de agregar la variable.

4. **Entrá a `https://tuservicio.pages.dev/panel.html`**, poné la
   contraseña, y ya podés dar de alta clientes y chips desde ahí en vez
   de escribir SQL a mano.

### Cómo funciona cada pestaña

- **Clientes** — alta de comercios nuevos y de sus chips. Al crear un
  cliente, el panel calcula solo la fecha de su primer reporte (regla
  de los días 7 y 22 que definimos). Los botones Activar/Suspender
  cambian el estado — esto es lo que hace que el chip redirija al
  destino real o a la página neutra.
- **Cobros** — todos los clientes ordenados por vencimiento más
  próximo. El botón de WhatsApp abre un mensaje pre-armado con el
  vencimiento y tu alias. "Marcar pagado" reactiva al cliente y corre
  el vencimiento un mes (o un año si es plan anual).
- **Reportes** — solo muestra clientes cuyo próximo reporte cae hoy o
  antes. El botón de WhatsApp incluye el conteo real de toques del
  período, sacado directo de la tabla `taps`. "Marcar enviado" calcula
  la fecha del próximo reporte automáticamente.
- **Inventario** — cuántos chips comprados, cuántos ya asignados a
  clientes (se calcula solo, contando los chips dados de alta), cuántos
  te quedan libres, y tu alias bancario para que salga en los mensajes.

### Advertencia honesta sobre la seguridad del panel

La protección con contraseña es simple y suficiente para esta etapa
(vos solo, un negocio chico empezando) — pero es básica: una sola
contraseña compartida, sin usuarios individuales ni recuperación si la
olvidás. El día que quieras algo más robusto (por ejemplo si alguien
más del equipo necesita entrar), **Cloudflare Access** es la opción
gratuita más sólida para agregar login real sin reescribir nada de
este código. No es necesario ahora, pero convenía que lo supieras antes
de asumir que esto es a prueba de todo.

### Un detalle a tener en cuenta con la fecha "30"

Cuando el mes no tiene día 30 completo en JavaScript (como febrero),
el cálculo de "reporte el 30" puede correrse al 1 o 2 de marzo por
cómo maneja las fechas el navegador. Para la mayoría de los meses no
pasa nada, pero en febrero convendría revisar a mano esa fecha puntual
cuando llegue. No lo resolví de más porque no vale la pena la
complejidad para un caso que ocurre una vez al año.

## Qué falta después de esto

- Cargar tu primer cliente real y su primer chip cuando llegue en 10 días.
- Decidir el mensaje exacto de aviso de atraso y de reporte (los que
  están en el código son un punto de partida, editalos a tu gusto
  directo en `panel.html`, buscando la palabra `mensaje`).
- Eventualmente: comprar el dominio y reemplazar `tuservicio.pages.dev`
  por el definitivo en `wrangler.toml`, en el chip suspendido de
  `[slug].js`, y en los links de `panel.html`.
