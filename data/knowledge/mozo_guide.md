# Guía de Usuario: Módulo de Restaurante (Mozo.pe)


**RESTAURANTE / MOZO.PE (Información Externa)**
Gestión especializada de pedidos para restaurantes.

**Resumen General:**
Mozo.pe es una extensión o módulo integrado especializado para la toma y gestión de pedidos (comandas), diseñado para flujos de "Trabajo en Salón" -> "Cocina" -> "Facturación".

**Características Clave:**
- **Toma de Pedidos (Mozos)**: Interfaz para tablets/móviles para registrar pedidos en mesa.
- **Gestión de Cocina (Kitchen Display)**: Panel visual con columnas: "Órdenes Recibidas", "Preparadas/Por Entregar" y "Entregadas".
- **Facturación Integrada**: Al cerrar una mesa, permite emitir boleta/factura electrónica directamente.

**Flujo de Trabajo Típico:**
1.  **Apertura de Mesa/Pedido**: El mozo selecciona productos del catálogo (con notas o modificaciones).
2.  **Envío a Cocina**: El pedido aparece en la pantalla de cocina.
3.  **Preparación**: Cocina marca el plato como "Listo".
4.  **Entrega y Cobro**: El mozo entrega y posteriormente cierra la cuenta emitiendo el comprobante.

**Casos de Uso:**
Ideal para Restaurantes de mesa, cafeterías, bares y dark kitchens que necesitan coordinar salón y cocina.

**Detalle del Módulo de Mesas (Mozo.pe):**
- **Estados de Mesa**:
    - 🟢 **Libre**: Disponible.
    - 🟡 **Ocupada**: En servicio (Muestra tiempo transcurrido "170 hs y 0 min").
- **Proceso de Pedido**:
    1.  **Abrir Mesa**: Definir cantidad de personas, mozo asignado y cliente opcional.
    2.  **Tomar Pedido**: Navegar por categorías o buscar productos para agregar a la lista.
    3.  **Acciones de Mesa**:
        -   **Precuenta**: Imprimir ticket provisional de consumo.
        -   **Enviar a Comanda**: Enviar pedido a visualización de cocina (Imprimir o Digital).
        -   **Cerrar Mesa**: Finalizar el servicio.
- **Facturación (Cierre)**:
    -   **"Por Consumo"**: Genera una boleta/factura con una sola línea "Por consumo" por el monto total (Rápido).
    -   **"Finalizar Venta"**: Genera un comprobante detallado ítem por ítem.
    -   *Nota: Solo Administradores pueden finalizar venta.*
- **Configuración**: Las mesas pueden editarse en nombre y forma (Cuadrada/Circular) para replicar el plano del restaurante.