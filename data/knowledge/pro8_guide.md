# BASE DE CONOCIMIENTO: MÓDULOS DE FACTURADOR PRO 8

A continuación se detalla la estructura exacta del menú del sistema y la funcionalidad de cada módulo. Usa esta información para guiar al usuario unicamente si te preguntan sobre dudas acerca del sistema PRO8 unicamente pro8, no funciona en pro7 o prox.


**Secciones y Métricas Principales:**
- **Resumen Financiero**: Totales de Ventas, Compras, y Balance General (Utilidades/Ganancias).
- **Gráficos de Rendimiento**: Visualización de ventas a lo largo del tiempo.
- **Alertas de Stock**: Listado de productos por agotarse para reposición rápida.
- **Top Clientes**: Listado de clientes con mayores volúmenes de compra.
- **Cuentas por Cobrar/Pagar**: Resumen rápido de deudas y créditos pendientes.

## 2. PREVENTA
(Menú Padre Desplegable - No es una página)
Gestión de oportunidades y cotizaciones.
- **Oportunidad de venta**: Seguimiento de leads.
- **Cotizaciones**: Presupuestos formales.
- **Contratos**: Acuerdos de servicio.
- **Pedidos**: Notas de pedido internas.
- **Servicio de soporte técnico**: Recepción de equipos para reparación.

## 3. VENTAS
(Menú Padre Desplegable - No es una página)
Emisión de comprobantes y ventas directas.
- **Boleta/factura**: Comprobantes electrónicos para SUNAT. (Ruta: /documents)
- **Notas de Venta**: Comprobantes internos (Tickets) no fiscales. (Ruta: /sale-notes)
- **Punto de venta (POS)**: Interfaz de venta rápida para mostrador. (Ruta: /pos)
- **Venta rápida (Grifos y Markets)**: Interfaz simplificada. (Ruta: /pos/garage)

## 4. COMPRAS
(Menú Padre Desplegable - No es una página)
Gestión de aprovisionamiento.
- **Listado (Compras)**: Registro de facturas de proveedores.
- **Ord. de compra**: Órdenes formales a proveedores.
- **Gastos diversos**: Registro de gastos sin stock (Luz, agua).
- **Proveedores**: Directorio de proveedores.
- **Solicitar cotización**: Solicitudes de presupuesto a proveedores.
- **Activos fijos**: Control de bienes patrimoniales.
- **Comprar activo fijo**: Registro de compra de activo fijo.

## 5. CLIENTES
(Menú Padre Desplegable - No es una página)
- **Clientes**: Directorio de clientes.
- **Tipos de clientes**: Clasificación de clientes.

## 6. PRODUCTOS/SERVICIOS
(Menú Padre Desplegable - No es una página)
Gestión del catálogo.
- **Productos**: Bienes con stock.
- **Conjuntos y Packs**: Kits de productos.
- **Servicios**: Items intangibles.
- **Categorías**: Clasificación de productos.
- **Marcas**: Fabricantes.
- **Series**: Gestión de números de serie.

## 7. INVENTARIO
(Menú Padre Desplegable - No es una página)
Control de stock y almacenes.
- **Movimientos**: Ingresos/Salidas manuales.
- **Traslados**: Transferencias entre almacenes.
- **Devolucion a proveedor**: Salidas por devolución.
- **Reporte Kardex**: Historial detallado por producto.
- **Reporte Inventario**: Stock actual.
- **Kardex valorizado**: Valor monetario del inventario.

## 8. FINANZAS
(Menú Padre Desplegable - No es una página)
Gestión de dinero.
- **Caja general**: Apertura/Cierre y control de efectivo.
- **Movimientos**: Ingresos y Gastos manuales diversos.
- **Transacciones**: Operaciones bancarias.
- **Ingresos**: Entradas de dinero extraordinarias.
- **Cuentas por cobrar**: Deudas de clientes.
- **Cuentas por pagar**: Deudas a proveedores.
- **Pagos**: Historial de pagos.
- **Ingresos y Egresos - M. Pago**: Reporte por método de pago.
- **Credito Bancario**: Control de créditos financieros.

## 9. GUÍAS DE REMISIÓN
(Menú Padre Desplegable - No es una página)
Transporte de mercadería.
- **G.R. Remitente**: Guías propias (Vendedor).
- **G.R. Transportista**: Guías de transporte contratado.
- **Transportistas**: Empresas de transporte.
- **Conductores**: Choferes.
- **Vehículos**: Unidades de transporte.

## 10. COMPROBANTES PENDIENTES
(Menú Padre Desplegable - No es una página)
Gestión de envíos a SUNAT.
- **Comprobantes no enviados**: Pendientes de envío.
- **CPE pendientes de rectificación**: Observados.
- **Resúmenes**: De boletas diarias.
- **Anulaciones**: Comunicación de baja.

## 11. COMPROBANTES AVANZADOS
(Menú Padre Desplegable - No es una página)
Documentos especiales.
- **Retenciones**: Documentos de retención IGV.
- **Percepciones**: Documentos de percepción IGV.
- **Liquidaciones de compra**: Compras a sujetos sin RUC.
- **Ordenes de pedido**: Comprobantes de pedido.
- **Documentos de contingencia**: Comprobantes físicos por emergencia.


## 13. INFORMACIÓN GENERAL Y CARACTERÍSTICAS DEL SISTEMA PRO 8

**¿Qué es Pro 8?**
Pro 8 es una plataforma integral de gestión y facturación electrónica. Incluye:

### MÓDULOS ESPECIALIZADOS (VERTICALES / RUBROS)
El sistema cuenta con módulos adaptados para rubros específicos:

**1. Restaurante (Mozo.pe)**:

**2. Farmacia**:
   - **Objetivo**: Gestión de boticas y farmacias cumpliendo normativa.
   - **Configuración Previa**: Requiere activar el rubro "Farmacia" en la configuración del sistema.
   - **Funcionalidad Clave (DIGEMID)**: Al crear productos, permite añadir información del catálogo DIGEMID (Código, Nombre, Principio Activo, Concentración, etc.) para reportes obligatorios.

**3. Hoteles**:
   - **Objetivo**: Gestión integral de hospedajes, hostales y hoteles.
   - **Flujo de Configuración**: Para operar corresponectamente, se deben crear los elementos en este orden:
     1. **Pisos**: Definir los niveles del establecimiento.
     2. **Categorías**: Tipos de habitación (Simple, Doble, Matrimonial, Suite).
     3. **Tarifas**: Precios asociados a categorías o planes.
     4. **Habitaciones**: Creación final de habitaciones asignándoles piso, categoría y tarifa.
   - **Operativa Diaria (Recepción)**: 
     - **Recepción**: Panel visual general (Grid) que muestra el estado de cada habitación (Disponible, Ocupada, Limpieza, Mantenimiento).
     - **Procesos**: Check-in (Ingreso), Check-out (Salida/Cobro) y Servicios a la habitación.

**4. Educativo / Suscripción Escolar**:
   - Gestión de matrículas, pensiones y pagos recurrentes de estudiantes.

**5. Trámite Documentario**:
   - Seguimiento de expedientes y documentos internos/externos.

### ECOSISTEMA Y APPS
- **Tienda Virtual**: Landing page pública conectada al inventario para pedidos de clientes.
- **Apps Móviles**: "VendeYa" y "Mozo" para gestión desde dispositivos Android/iOS.
- **Integraciones**:
    - **Contabilidad**: Exportación compatible con sistemas contables (ej. Sire).
    - **API Pro 8**: API robusta para desarrolladores e integraciones de terceros.

### CARACTERÍSTICAS TÉCNICAS
- **Nube**: Almacenamiento seguro en la nube.
- **Multi-usuario**: Roles y permisos definibles por usuario.
- **Seguridad**: Respaldos automáticos y cifrado de datos.
- **Actualizaciones**: Automáticas y transparentes, siempre cumpliendo normativa SUNAT.

### REQUISITOS DEL SISTEMA
- Conexión a internet estable.
- Navegador moderno (Chrome, Firefox, Edge).
- App Móvil: Android 10+ / iOS 10+.
- Impresora térmica o láser para comprobantes.

## 14. SOLUCIÓN DE ERRORES FRECUENTES Y TIPS DE SOPORTE

### ERRORES DE SUNAT
**Error 0111 (No tiene perfil para enviar comprobantes):**
- **Causa**: El usuario secundario de SUNAT no tiene permisos o hay falla masiva en SUNAT.
- **Solución**: 
  1. Verificar usuario secundario en CLAVE SOL (Debe tener números y letras mayúsculas).
  2. Si es falla masiva, desactivar "Envío Automático" en Configuración > Avanzado y reintentar manual luego.

**Error "Ingresado como unidad de medida":**
- **Causa**: La unidad (NIU, ZZ, etc.) no coincide con el catálogo de SUNAT.
- **Solución**: Verificar el catálogo de unidades en Configuración y asegurar que el código SUNAT sea el correcto.

**Facturas/Boletas Rechazadas:**
- **Estado RECHAZADO**: No se puede corregir. Se debe emitir un **NUEVO** comprobante con nueva numeración (correlativo).
- **Facturas No Enviadas a Tiempo**: 
  - Si el estado es "NO EXISTE" en SUNAT, se puede habilitar el permiso "Editar CPE" en la configuración de empresa y usuario para cambiar la fecha y reenviar.

### ENVÍO DE BOLETAS PENDIENTES
Si las boletas no se enviaron automáticamente:
1. Ir a **Ventas** > **Resúmenes**.
2. Crear **Nuevo Resumen**.
3. Buscar boletas por fecha y generarlo.
4. Consultar ticket hasta obtener estado "ACEPTADO".

### CONFIGURACIONES ESPECIALES
**Activar IGV 10% (Ley Turismo/Restaurantes):**
- Ir a **Configuración** > **Sucursales & Series**.
- Editar el establecimiento y marcar check: "Sujeto al IGV - Ley 31556".

**Ver Logs del Sistema (Depuración):**
- Icono de "Insecto" (Bug) en la parte inferior izquierda del menú lateral.
- Muestra errores técnicos para enviar a soporte (Capturar fecha y mensaje).

**Certificado SSL (Seguridad):**
- Verificar vigencia haciendo clic en el candado del navegador (HTTPS). Se renueva típicamente cada 3 meses (Let's Encrypt).

## 15. GUÍAS ADICIONALES Y TIPS AVANZADOS

### CERTIFICADOS DIGITALES
**Certificado Gratuito de SUNAT:**
- **Dirigido a**: Mypes (Micro y Pequeñas Empresas) con ingresos netos anuales ≤ S/ 1,260,000 (aprox).
- **Vigencia**: 3 años.
- **Requisitos**: RUC Activo y Habido, pago de renta de 3ra categoría, y no usar OSE/PSE.
- **Restricción**: Máximo 2 certificados gratuitos.

### FACTURACIÓN Y ENVÍO
**Enviar Comprobante por WhatsApp:**
- Ir a **Ventas** > **Listado de comprobantes**.
- Click en **Opciones** (3 puntos) del comprobante > **Enviar a WhatsApp**.
- Ingresar número (sin espacios) y enviar. Requiere tener WhatsApp instalado/abierto.

**Consultar Validez de Comprobantes (SUNAT):**
- Acceder al Portal SUNAT con Clave SOL.
- Ir a **Empresas** > **Consulta integrada de validez de comprobantes de pago**.
- Permite verificar si una factura/boleta realmente existe y es válida para SUNAT.

**Consulta API DNI/RUC:**
- El servicio de consulta integrado **NO** es directo de RENIEC, usa fuentes públicas y el padrón reducido de SUNAT.
- **Limitación**: No devuelve datos sensibles de menores, ni fecha de nacimiento exacta en todos los casos.
- Si no retorna datos, no es necesariamente un error del sistema, sino falta de información en la fuente pública.

### PRODUCTOS
**Precios Diferenciados por Almacén:**
- El sistema permite asignar precios distintos a un mismo producto según donde esté almacenado.
- Al editar un producto, en la sección de **Precios/Presentaciones**, se puede especificar el valor para cada establecimiento/almacén.

## 12. CONTABILIDAD
(Menú Padre Desplegable - No es una página):
- **Exportar reporte**: Formatos generales.
- **Exportar formatos - Sis. Contable**: Integración contable.
- **Reporte resumido - Ventas**: Resumen de ventas.
- **Libro Mayor**: Reporte contable mayor.
- **SIRE**:
  - **Ventas**: Módulo SIRE Ventas.
  - **Compras**: Módulo SIRE Compras.

## 13. REPORTES
(Enlace directo)
- **Reportes**: Panel central de reportes analíticos.

## 14. TIENDA VIRTUAL
(Menú Padre Desplegable - No es una página)
Ecommerce integrado.
- **Ir a Tienda**: Abre la tienda pública.
- **Pedidos**: Órdenes web.
- **Productos Tienda Virtual**: Configuración web de productos.
- **Conjuntos y Packs**: Promociones compuestas web.
- **Tags - Categorias(Etiquetas)**: Etiquetas web.
- **Promociones(Banners)**: Banners publicitarios.

## 15. RESTAURANTE
(Menú Padre Desplegable - No es una página)
Gestión de mesas y cocina.
- **Productos**: Platos y bebidas.
- **Insumos**: Ingredientes.
- **Modificadores**: Guarniciones/Términos.
- **Pedidos Delivery**:
  - Ver pedidos en linea.
  - Listado de pedidos.
  - Promociones(Banners).
- **Config. Mesas/Cocina**: Configuración de ambientes.

## 16. HOTELES
(Menú Padre Desplegable - No es una página)
Gestión de alojamiento.
- **Recepción**: Front desk.
- **Tarifas**: Precios por temporada.
- **Ubicaciones**: Pisos/Sectores.
- **Categorías**: Tipos de habitación.
- **Habitaciones**: Cuartos.

## 17. SUSCRIPCIÓN (Beta)
(Menú Padre Desplegable - No es una página)
- **Clientes**: Suscriptores.
- **Planes**: Planes recurrentes.
- **Suscripciones**: Contratos activos.
- **Recibos de pago**: Comprobantes generados.

## 18. SUSCRIPCIÓN ESCOLAR (Beta)
(Menú Padre Desplegable - No es una página)
- **Clientes**:
  - **Padres**.
  - **Hijos**.
- **Planes**: Pensiones.
- **Matrículas**: Inscripciones.
- **Recibos de pago**: Recibos generados.
- **Grados y Secciones**: Aulas.

## 19. TRÁMITE DOCUMENTARIO
(Menú Padre Desplegable - No es una página)
Mesa de partes y expedientes.
- **Listado de Etapas**: Flujo del trámite.
- **Listado de Estados**: Status (Pendiente, Finalizado).
- **Listado de requisitos**: Requisitos por trámite.
- **Tipos de Trámites**: Clasificación.
- **Listado de Trámites**: Bandeja de expedientes.
- **Estadisticas de Trámites**: Dashboard de trámites.

---

# GUÍA DE PROCESOS CLAVE (WORKFLOWS DETALLADOS)

Esta sección describe cómo navegar y usar las funciones principales siguiendo estrictamente el menú.

## 1. PREVENTA
### CREAR UNA COTIZACIÓN
1. **Navegación**: Ve al menú **Preventa** > **Cotizaciones**.
2. **Acción**: Haz clic en el botón naranja "Crear".
3. **Paso a paso**:
   - Selecciona el cliente o crea uno nuevo.
   - Agrega los productos con el botón "Agregar Producto".
   - Define la condición de pago y validez.
   - Guarda para generar el PDF.

### GESTIONAR OPORTUNIDADES (LEADS)
1. **Navegación**: Ve a **Preventa** > **Oportunidad de venta**.
2. **Acción**: Nuevo registro para clientes potenciales.

### CREAR CONTRATOS
1. **Navegación**: Ve a **Preventa** > **Contratos**.
2. **Uso**: Para servicios recurrentes con fecha de inicio y fin.

## 2. VENTAS
### EMITIR FACTURA O BOLETA
1. **Navegación**: Ve al menú **Ventas** > **Boleta/factura**.
2. **Acción**: Haz clic en el botón naranja "Crear".
3. **Detalles**:
   - Si es Factura, el cliente debe tener RUC.
   - Si es Boleta, puede ser DNI o "Clientes Varios".
   - La opción de pago al contado o crédito define si va a Cuentas por Cobrar.

### EMITIR NOTA DE VENTA (TICKET INTERNO)
1. **Navegación**: Ve a **Ventas** > **Notas de Venta**.
2. **Acción**: Clic en "Crear".
3. **Importante**: Este documento descuenta stock pero NO se envía a SUNAT.

### USAR EL PUNTO DE VENTA (POS)
1. **Navegación**: Ve a **Ventas** > **Punto de venta**.
2. **Interfaz**: Pantalla táctil para selección rápida de productos por categoría y cobro ágil.

## 3. COMPRAS
### REGISTRAR UNA COMPRA
1. **Navegación**: Ve al menú **Compras** > **Listado**.
2. **Acción**: Clic en "Crear".
3. **Datos**: Ingresa el XML o llena manualmente los datos de la factura de tu proveedor para cargar el stock.

### GASTOS DIVERSOS
1. **Navegación**: Ve a **Compras** > **Gastos diversos**.
2. **Acción**: Clic en "Crear".
3. **Uso**: Registra recibos de luz, agua, alquiler o planillas.

## 4. PRODUCTOS Y SERVICIOS
### CREAR PRODUCTO
1. **Navegación**: Ve a **Productos/Servicios** > **Productos**.
2. **Acción**: Botón "Nuevo".
3. **Datos**: Nombre, Precio, Stock Inicial, Código de sunat (opcional).

### CREAR PACKS (COMBOS)
1. **Navegación**: Ve a **Productos/Servicios** > **Conjuntos y Packs**.
2. **Acción**: Define un nombre para el pack y selecciona qué productos individuales lo componen.

## 5. INVENTARIO
### AJUSTAR STOCK (MOVIMIENTOS)
1. **Navegación**: Ve a **Inventario** > **Movimientos**.
2. **Acción**: Crear nuevo movimiento de Entrada o Salida para corregir stock manualmente.

### TRASLADAR ENTRE ALMACENES
1. **Navegación**: Ve a **Inventario** > **Traslados**.
2. **Acción**: Selecciona almacén origen y destino.

### REPORTES DE INVENTARIO
1. **Kardex**: Ve a **Inventario** > **Reporte Kardex** para ver el historial de un item.
2. **Stock Actual**: Ve a **Inventario** > **Reporte Inventario** para ver saldo total.

## 6. FINANZAS
### GESTIÓN DE CAJA
1. **Navegación**: Ve al menú **Finanzas** > **Caja general**.
2. **Acción**:
   - **Aperturar caja**: Al inicio del día.
   - **Cerrar caja**: Al final del turno para ver el cuadre.

### REGISTRAR INGRESOS/GASTOS EXTRAS
1. **Navegación**: Ve a **Finanzas** > **Movimientos**.
2. **Acción**: Nuevo Movimiento. Elige si es Ingreso o Gasto y pon el motivo.

### COBRAR A CLIENTES
1. **Navegación**: Ve a **Finanzas** > **Cuentas por cobrar**.
2. **Acción**: Busca al cliente y haz clic en "Pagar" para registrar el abono.

### PAGAR A PROVEEDORES
1. **Navegación**: Ve a **Finanzas** > **Cuentas por pagar**.
2. **Acción**: Busca la factura de compra pendiente y registra el pago.

### VER BANCOS
1. **Navegación**: Ve a **Finanzas** > **Transacciones**.

## 7. TIENDA VIRTUAL
### VER PEDIDOS WEB
1. **Navegación**: Ve al menú **Tienda Virtual** > **Pedidos**.
2. **Acción**: Revisa las órdenes que llegan desde la página web.

### CONFIGURAR PRODUCTOS WEB
1. **Navegación**: Ve a **Tienda Virtual** > **Productos Tienda Virtual**.
2. **Acción**: Sube fotos y descripciones para la web.

## 8. RESTAURANTE
### GESTIÓN DE MESAS
1. **Navegación**: Ve a **Restaurante** (o POS Restaurante).
2. **Uso**: Abre mesas, agrega pedidos (mozo) y envía comanda a cocina.

### DELIVERY
1. **Navegación**: Ve a **Restaurante** > **Pedidos Delivery** > **Listado de pedidos**.

## 9. HOTELES
### RECEPCIÓN
1. **Navegación**: Ve al menú **Hoteles** > **Recepción**.
2. **Uso**: Ver grid de habitaciones, hacer Check-in y Check-out.

## 10. TRÁMITE DOCUMENTARIO
### GESTIÓN DE EXPEDIENTES
1. **Navegación**: Ve al menú **Trámite documentario** > **Listado de Trámites**.
2. **Uso**: Ver estado y ubicación de documentos en flujo.

---

## 20. SISTEMA DE FACTURACIÓN Y ERRORES SUNAT (DETALLADO)

### CONCEPTOS BÁSICOS
La **Facturación Electrónica** reemplaza los documentos físicos para mejorar la eficiencia y control tributario.
- **Tipos**: Facturas, Boletas, Notas de Crédito/Débito, Guías de Remisión.
- **Flujo**: Emisión -> Envío a OSE/SUNAT -> Validación (CDR).

### CLASIFICACIÓN DE ERRORES SUNAT
El sistema de SUNAT responde con códigos específicos que determinan la validez del documento.

**1. EXCEPCIONES (Códigos 0100 - 1999)**
- **Significado**: Errores graves de sistema, estructura o autenticación. El documento NO ha sido procesado.
- **Causas Comunes**:
  - ZIP corrupto o vacío.
  - Usuario/Clave SOL incorrectos o no activos.
  - Servicio de SUNAT no disponible.
  - Error en nombre del archivo XML.
- **Acción**: Corregir el error técnico y **volver a enviar** el mismo documento (mismo correlativo).

**2. RECHAZOS (Códigos 2000 - 3999)**
- **Significado**: El documento llegó a SUNAT pero contiene datos inválidos o inconsistentes.
- **Consecuencia Crítica**: El número (correlativo) queda **INUTILIZADO**.
- **Causas Comunes**:
  - RUC del emisor/receptor no Activo o no Habido.
  - Error de cálculos (Sumatorias de impuestos no cuadran).
  - Firma digital inválida o alterada.
  - Duplicidad de envío (Comprobante ya existe).
- **Acción**:
  1. Anular/Descartar internamente el documento rechazado.
  2. Emitir un **NUEVO** comprobante con nueva numeración corregida.

**3. OBSERVACIONES (Códigos 4000+)**
- **Significado**: El documento ha sido **ACEPTADO** y es válido, pero tiene advertencias menores.
- **Causas Comunes**:
  - Datos de dirección no cumplen formato estándar.
  - Documento relacionado ya presentado.
  - RUC no activo (en ciertos contextos).
- **Acción**: No se requiere reenvío. Corregir datos maestros para futuros envíos.

### GUÍAS DE REMISIÓN
**Anulación de Guías:**
- **Restricción Temporal**: Solo se pueden anular el **mismo día** de la emisión.
- **Método Único**: La anulación se debe realizar **Exclusivamente desde el Portal SOL de SUNAT**.
- **Ruta SUNAT**: Empresas > Guía de Remisión Electrónica > Baja de guía.

## 21. CONFIGURACIÓN DE PANTALLA Y CERTIFICADOS (PASOS)

### PANEL DE BIENVENIDA
Ventana informativa ("Pop-up") al iniciar sesión.
**Pasos para Activar/Desactivar:**
1. Login como Administrador.
2. Clic en Icono de Perfil (Arriba derecha) > **Estilos y temas**.
3. Buscar opción "Mostrar panel de bienvenida en el dashboard".
4. Seleccionar **SÍ** o **NO**.

### CERTIFICADO DIGITAL COMPRADO
Si se adquiere un certificado digital (PFX) externo (no el gratuito de SUNAT), se deben seguir dos procesos obligatorios:

**Paso 1: Subir a SUNAT**
1. Ingresar a SUNAT Operaciones en Línea (Clave SOL).
2. Ir a **Certificados Digitales** > **Registro/Mantenimiento** > **Subir certificado digital**.
3. Ingresar alias, clave privada/pública y cargar el archivo.
   - *Nota*: Puede requerir conversión de formato PFX a CER/KEY si SUNAT lo solicita.

**Paso 2: Subir al Sistema Pro 8**
1. Ir a **Configuración** > **Empresa**.
2. Sección **Certificado Digital**.
3. Cargar el archivo .pfx y la contraseña del certificado.
4. Guardar cambios.

## 22. INFORMACIÓN DE CONTACTO Y SOPORTE (DIGITAL BUHO)

### DATOS GENERALES
- **Razón Social**: Digital Buho S.A.C.
- **RUC**: 20600000001
- **Teléfono Soporte**: 944 999 965
- **Email**: hola@buho.la
- **Web**: https://buho.la

### HORARIOS DE ATENCIÓN
- **Lunes a Viernes**: 9:00 AM - 6:00 PM
- **Sábados**: 9:00 AM - 1:00 PM

### SOBRE NOSOTROS
Somos expertos en soluciones de facturación electrónica y transformación digital para empresas peruanas.

