
<p align="center">
  <img src="https://img.shields.io/badge/Platform-Node.js-339933?logo=nodedotjs&logoColor=white&style=for-the-badge" alt="Node.js Badge" />
  <img src="https://img.shields.io/badge/Language-JavaScript-F7DF1E?logo=javascript&logoColor=black&style=for-the-badge" alt="JavaScript Badge" />
  <img src="https://img.shields.io/badge/AI-Google%20Gemini-8E75C2?logo=googlegemini&logoColor=white&style=for-the-badge" alt="Gemini Badge" />
  <img src="https://img.shields.io/badge/Database-MySQL-4479A1?logo=mysql&logoColor=white&style=for-the-badge" alt="MySQL Badge" />
  <img src="https://img.shields.io/badge/API-WhatsApp%20Cloud-25D366?logo=whatsapp&logoColor=white&style=for-the-badge" alt="WhatsApp Badge" />
</p>


## 📋 Descripción

Proyecto acerca de un Chatbot para WhatsApp potenciado con Inteligencia Artificial (Google Gemini) enfocado en la atención de productos y servicios de una empresa o emprendimiento. Cuenta con un panel de administración web, persistencia relacional en MySQL y un módulo scraper automatizado para sincronizar el catálogo comercial.

<p align="center">
  <img width="1356" height="632" alt="{715E7CF7-389C-4591-B9F7-BB54A4DD773C}" src="https://github.com/user-attachments/assets/ff4ddb1a-7afe-45a9-bbe1-cc2cc758ba71" />
</p>

---

## 🛠️ Stack Tecnológico

El servidor, base de datos y motor de IA están construidos utilizando:

*   **Servidor Backend:** Node.js + Express
*   **Orquestador de IA:** Google Gemini API (con rotación dinámica de múltiples API keys y control de errores por circuit breaker)
*   **Integración de Mensajería:** WhatsApp Cloud API
*   **Base de Datos / Persistencia:** MySQL (producción) y archivos JSON locales (redundancia/desarrollo)
*   **Panel Administrativo:** Frontend web interactivo servido en la raíz de Express
*   **Scraper de Catálogo:** Playwright + Cheerio + Axios

---

## 🚀 Características & Soluciones

*   💬 **Atención Inteligente:** Responde mensajes de clientes en lenguaje natural de forma autónoma.
*   🎙️ **Procesamiento de Audio (Notas de Voz):** Recibe audios de WhatsApp, los transcribe usando Gemini y responde de forma contextual.
*   📖 **Conocimiento Personalizado:** Estructura respuestas con contexto dinámico inyectado desde `data/knowledge/`.
*   🧠 **Memoria Conversacional:** Maneja un historial con ventana deslizable configurable globalmente o por usuario.
*   ⚙️ **Panel de Configuración en Vivo:** Permite tunear y actualizar el prompt e instrucciones en caliente sin reiniciar el servidor.
*   📊 **Auditoría y Trazabilidad (Chat Mirror):** Copia los chats en tiempo real a MySQL para auditoría y visualización externa.
*   🔄 **Actualización de Productos:** Scraper integrado que sincroniza automáticamente la información comercial de la web de Buho.
*   📈 **Módulo de Reportes & Analítica IA:** Clasifica automáticamente intenciones, valoraciones, estados de compra y embudos directamente desde las interacciones con IA.

<p align="center">
  <img width="900" height="636" alt="{3E92E765-25E0-4486-8A79-EC5CE3F7D778}" src="https://github.com/user-attachments/assets/522ded31-0f37-47e3-9438-8ff96b4cad14" />

</p>

---

## 🏗️ Arquitectura Funcional del Flujo

1.  **Entrada:** Meta envía eventos mediante webhooks HTTP POST al servidor.
2.  **Firma y Seguridad:** Se valida el payload mediante firma digital HMAC SHA-256 (`META_APP_SECRET`).
3.  **Gestión de Cola:** `bot_handler` filtra mensajes duplicados, aplica control de tasa (rate limits) y encola solicitudes por número de teléfono.
4.  **Generación de Contexto:** Reúne el historial conversacional reciente y lee los documentos de conocimiento relevantes.
5.  **Ejecución IA:** Se invoca a Gemini mediante la rotación activa de API keys para procesar y redactar la respuesta.
6.  **Salida:** `whatsapp_service` despacha el mensaje formateado (o el audio correspondiente) al cliente final.
7.  **Registro:** Se guardan las métricas de respuesta y el registro de la conversación en las tablas MySQL correspondientes.

<p align="center">
<img width="1359" height="635" alt="{88B1B590-5E4B-4F47-879E-78AEA5DF1809}" src="https://github.com/user-attachments/assets/fbce3c5b-18f6-4f0b-85a1-80ab7df0bfa1" />
</p>

---

## 📊 Módulo de Reportes y Analítica IA

El sistema cuenta con un motor de clasificación y análisis automatizado post-conversación:
1.  **Inserción de Insights:** Cada interacción del usuario es clasificada en tiempo real a nivel de base de datos en la tabla `conversation_insights` registrando:
    *   **Intención (Intent):** Saludos, quejas, interés de compra, etc.
    *   **Etapa Comercial:** Fase del embudo (Descubrimiento, Selección, Cierre).
    *   **Producto Consultado:** Identificación del producto específico del catálogo.
    *   **Resultado (Outcome):** Si compró, solo preguntó, o reportó problemas.
    *   **Valoración (Sentiment):** Sentimiento del mensaje (positivo, neutro, negativo).
2.  **Visualización:** El panel web consume estos datos para mostrar analíticas en la pestaña **Reportes**, incluyendo embudos comerciales gráficos, gráficos de sentimientos, y un buscador indexado de insights.

<p align="center">
<img width="1353" height="633" alt="{4C20D7DE-71D0-4148-9311-993F9B4D1B93}" src="https://github.com/user-attachments/assets/75b0d114-49f9-43f8-91ef-907cddcfcc2f" />
</p>

---

## 🎙️ Soporte para Mensajes de Voz y Audios

El sistema integra un canal de análisis de notas de voz recibidas por WhatsApp:
1.  **Detección:** El webhook intercepta un payload multimedia de tipo `audio`.
2.  **Descarga:** Descarga los bytes del archivo en formato nativo desde los servidores de Meta.
3.  **Procesamiento IA:** Envía el audio (en formato base64) directamente a Gemini con un prompt del sistema para transcribir.
4.  **Flujo conversacional:** La transcripción de texto se inyecta en el orquestador conversacional principal de igual manera que un mensaje regular, respondiendo con el contexto de catálogo.
5.  **Formatos Compatibles:** `audio/ogg`, `audio/ogg; codecs=opus`, `audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/webm`, `audio/mp4`, y `audio/aac`.

---
## 📂 Módulos Clave del Proyecto

*   [`server.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/server.js): Inicialización del servidor, middlewares globales, endpoints principales y manejo de apagado limpio.
*   [`config.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/config.js): Archivo centralizador de configuración de variables de entorno y defaults operativos.
*   [`scrape_buho_store.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/scrape_buho_store.js): Script scraper independiente para extraer la estructura de planes comerciales de Digital Buho.
*   **`src/handlers/`**
    *   [`webhook.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/src/handlers/webhook.js): Recepción de webhooks de Meta y validación del token de suscripción.
    *   [`bot_handler.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/src/handlers/bot_handler.js): Lógica del ciclo de vida del mensaje (recepción de textos, imágenes, voz y delegaciones).
*   **`src/services/`**
    *   [`gemini_service.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/src/services/gemini_service.js): Comunicación con Google Gemini, rotación balanceada de llaves y control de timeouts.
    *   [`whatsapp_service.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/src/services/whatsapp_service.js): Cliente HTTP de WhatsApp Cloud API, descargas multimedia y control de reintentos.
    *   [`mysql_service.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/src/services/mysql_service.js): Pool de conexiones relacionales y funciones de verificación de estado.
    *   [`knowledge_loader.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/src/services/knowledge_loader.js): Indexación y carga de la información de catálogo en JSON local.
    *   [`conversation_store_service.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/src/services/conversation_store_service.js): Guardado híbrido de chats en local y réplica transaccional en MySQL.
    *   [`buho_store_scheduler.js`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/src/services/buho_store_scheduler.js): Planificador (cron) para ejecutar el scraping de catálogo de manera automática.

---

## 🛠️ Requisitos de Entorno

*   Node.js v18.0.0 o superior
*   npm v9.0.0 o superior
*   MySQL v8.0 o superior
*   Cuenta de Meta Developer con WhatsApp Cloud API configurado
*   Claves API activas de Google Gemini (Google AI Studio)

---

## 🚀 Instalación y Despliegue

### 1. Clonar e Instalar
```bash
npm install
```

### 2. Configurar Variables de Entorno
Crea un archivo `.env` en la raíz del proyecto con la siguiente estructura:

```env
PORT=3000
NODE_ENV=development

# API Google Gemini (Llaves separadas por comas o numeradas para rotación automática)
GEMINI_API_KEY_1=AIzaSy...
GEMINI_API_KEY_2=AIzaSy...
GEMINI_API_KEY_3=
GEMINI_TIMEOUT_MS=25000
GEMINI_TOTAL_TIMEOUT_MS=100000
GEMINI_MAX_ATTEMPTS=2

# WhatsApp Cloud API & Meta Webhooks
WHATSAPP_TOKEN=EAAG...
WHATSAPP_PHONE_NUMBER_ID=109...
WEBHOOK_VERIFY_TOKEN=tu_token_de_verificacion_personalizado
META_APP_SECRET=a8b3...

# API de Administración & Seguridad
ADMIN_API_TOKEN=un_token_seguro_y_largo
ADMIN_API_ALLOW_DEV_FALLBACK=true

# Base de Datos MySQL
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=contrasena_base_de_datos
DB_NAME=ia_buho

# Planificador del Scraper
BUHO_STORE_SCRAPER_ENABLED=true
BUHO_STORE_SCRAPER_CRON=0 3 * * *
BUHO_STORE_SCRAPER_TZ=America/Lima
```

### 3. Preparación de la Base de Datos
Importa el esquema SQL inicial para estructurar las tablas de auditoría y configuración:
*   Ubicación: [`db/mysql/schema.sql`](file:///c:/Users/julio/OneDrive/Pictures/Proyectos%20Visual%20Studio/BuhoDigitalGemini/db/mysql/schema.sql)
```bash
# Puedes importarlo desde tu consola de comandos de MySQL o herramienta gráfica:
# mysql -u root -p ia_buho < db/mysql/schema.sql
```

---

## 🏃 Comandos de Ejecución

| Comando | Descripción |
| :--- | :--- |
| `npm start` | Inicia la aplicación en modo producción. |
| `npm run dev` | Inicia la aplicación en modo desarrollo con recarga en caliente (`nodemon`). |
| `npm run scrape:store` | Ejecuta el script del scraper de forma manual e inmediata. |

Para probar el scraper apuntando a un producto específico desde Windows PowerShell:
```powershell
$env:SCRAPE_ONLY='fastura_colombia'; node scrape_buho_store.js
```

---

## 🔌 API Endpoints Principales

### Endpoints del Webhook e Integración
*   `GET /health` - Retorna el estado en vivo de la conexión a MySQL, API Keys activas y métricas de procesamiento.
*   `GET /webhook` - Usado por la consola de Meta para la validación y handshaking del webhook.
*   `POST /webhook` - Recepción de los mensajes entrantes, estados de entrega y eventos desde WhatsApp.

### Endpoints de Administración (Requieren header `Authorization: Bearer <TOKEN>` o `X-Admin-Token`)
*   `GET /api/config` - Devuelve la configuración runtime actual.
*   `PUT /api/config` - Modifica la configuración (prompts, filtros, modelos) en caliente.
*   `GET /api/users` - Listado de números que han interactuado con el bot.
*   `GET /api/users/:phone/config` - Parámetros de personalización y contexto de un cliente específico.
*   `PUT /api/users/:phone/config` - Modifica dinámicamente las reglas para un usuario.
*   `GET /api/chat/:phone` - Devuelve el historial del chat espejo en formato estructurado.
*   `GET /api/chat/:phone/count` - Estadísticas y cantidad de mensajes enviados por un usuario.

### Endpoints del Módulo de Reportes
*   `GET /api/reports/summary` - Devuelve KPIs generales de analítica (tasa de conversión, interacciones, satisfacción, quejas).
*   `GET /api/reports/insights` - Obtiene la lista filtrada y paginada de intenciones clasificadas.
*   `GET /api/reports/topics` - Lista los temas de conversación más frecuentes categorizados.
*   `GET /api/reports/products` - Retorna estadísticas de los productos más consultados con su resultado comercial.
*   `GET /api/reports/funnel` - Distribución cuantitativa de las fases del embudo comercial (Discovery, Product Interest, Closing, etc.).
*   `GET /api/reports/intents` - Distribución porcentual y total de intenciones (greeting, support, purchase_interest, etc.).

---

## 📄 Licencia

Este software es propiedad exclusiva de **Digital Buho**. Todos los derechos reservados. Su uso, copia y distribución están regulados por los contratos corporativos de la empresa.


Creado con ❤️ por [juliots04](https://github.com/juliots04) 
 
 
