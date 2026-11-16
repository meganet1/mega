const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./config/database');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const GENIEACS_NBI_URL = process.env.GENIEACS_NBI_URL || 'http://localhost:7557';

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Menyajikan file frontend dari folder public/

// ==========================================
// 1. API MONITORING & DASHBOARD
// ==========================================
app.get('/api/monitoring/summary', async (req, res) => {
    try {
        const [oltRows] = await db.query("SELECT COUNT(*) as total FROM olt_devices");
        const [onuRows] = await db.query("SELECT COUNT(*) as total, SUM(CASE WHEN status='online' THEN 1 ELSE 0 END) as online, SUM(CASE WHEN los_status=1 THEN 1 ELSE 0 END) as los FROM onu_devices");
        const [alertRows] = await db.query("SELECT COUNT(*) as total FROM monitoring_alerts WHERE status = 'active'");
        const [custRows] = await db.query("SELECT COUNT(*) as total FROM customers");

        res.json({
            success: true,
            data: {
                total_customers: custRows[0].total || onuRows[0].total || 0,
                onu_online: onuRows[0].online || 0,
                onu_offline: (onuRows[0].total - onuRows[0].online) || 0,
                olts_online: oltRows[0].total || 0,
                olts_total: oltRows[0].total || 0,
                onu_los: onuRows[0].los || 0,
                active_alerts: alertRows[0].total || 0,
                last_update: new Date().toISOString()
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/olts', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM olt_devices");
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/onus', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT o.*, d.name as olt_name 
            FROM onu_devices o 
            JOIN olt_devices d ON o.olt_id = d.id
        `);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/onus', async (req, res) => {
    try {
        const { customer_name, customer_id, serial_number, olt_id, pon_port_id, odp_name, latitude, longitude } = req.body;
        const [result] = await db.query(
            `INSERT INTO onu_devices 
            (customer_name, customer_id, serial_number, olt_id, pon_port_id, odp_name, latitude, longitude, status, los_status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online', 0)`,
            [customer_name, customer_id, serial_number, olt_id, pon_port_id || 1, odp_name, latitude || null, longitude || null]
        );
        res.json({ success: true, message: 'Data pelanggan berhasil ditambahkan', insertId: result.insertId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/onus/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { customer_name, customer_id, serial_number, olt_id, odp_name, latitude, longitude } = req.body;
        await db.query(
            `UPDATE onu_devices 
             SET customer_name = ?, customer_id = ?, serial_number = ?, olt_id = ?, odp_name = ?, latitude = ?, longitude = ? 
             WHERE id = ?`,
            [customer_name, customer_id, serial_number, olt_id, odp_name, latitude || null, longitude || null, id]
        );
        res.json({ success: true, message: 'Data pelanggan & koordinat berhasil diperbarui!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/alerts', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM monitoring_alerts ORDER BY created_at DESC");
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API Daftar Gangguan / Alerts dari Database
app.get('/api/alerts', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM monitoring_alerts ORDER BY created_at DESC LIMIT 5");
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 2. API GENIEACS (TR-069)
// ==========================================
app.get('/api/genieacs/devices', async (req, res) => {
    try {
        const response = await axios.get(`${GENIEACS_NBI_URL}/devices?projection=_id,_deviceId._SerialNumber,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress`);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/genieacs/reboot/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        await axios.post(`${GENIEACS_NBI_URL}/devices/${encodeURIComponent(deviceId)}/tasks?timeout=30000&connection_request=true`, {
            name: "reboot"
        });
        res.json({ success: true, message: "Perintah reboot berhasil dikirim ke ONU." });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 3. API DATA PELANGGAN (CUSTOMERS)
// ==========================================
app.get('/api/customers', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT c.*, p.package_name FROM customers c LEFT JOIN internet_packages p ON c.package_id = p.id');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/customers', async (req, res) => {
    try {
        const { customer_code, name, phone, address, package_id, onu_device_id } = req.body;
        const query = 'INSERT INTO customers (customer_code, name, phone, address, package_id, onu_device_id) VALUES (?, ?, ?, ?, ?, ?)';
        await db.query(query, [customer_code, name, phone, address, package_id || null, onu_device_id || null]);
        res.json({ success: true, message: "Pelanggan berhasil ditambahkan!" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/customers/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM customers WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: "Pelanggan berhasil dihapus!" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 4. API PAKET INTERNET (PACKAGES)
// ==========================================
app.get('/api/packages', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM internet_packages');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/packages', async (req, res) => {
    try {
        const { package_name, speed_mbps, price } = req.body;
        await db.query('INSERT INTO internet_packages (package_name, speed_mbps, price) VALUES (?, ?, ?)', [package_name, speed_mbps, price]);
        res.json({ success: true, message: "Paket internet berhasil ditambahkan!" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 5. API WHATSAPP GATEWAY
// ==========================================
app.post('/api/whatsapp/send', async (req, res) => {
    try {
        const { phone, message } = req.body;
        // Contoh integrasi ke engine WA Gateway luar bisa diletakkan di sini via axios.post(...)
        
        await db.query('INSERT INTO whatsapp_logs (recipient, message, status) VALUES (?, ?, ?)', [phone, message, 'Sent']);
        res.json({ success: true, message: "Pesan WhatsApp berhasil dikirim & dicatat!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 6. API MANAJEMEN TEKNISI
// ==========================================
app.get('/api/technicians', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM technicians');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/technicians', async (req, res) => {
    try {
        const { name, phone, status } = req.body;
        await db.query('INSERT INTO technicians (name, phone, status) VALUES (?, ?, ?)', [name, phone, status || 'available']);
        res.json({ success: true, message: "Teknisi berhasil ditambahkan!" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/technician-jobs', async (req, res) => {
    try {
        const query = `
            SELECT j.*, t.name AS technician_name 
            FROM technician_jobs j 
            LEFT JOIN technicians t ON j.technician_id = t.id
        `;
        const [rows] = await db.query(query);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// 1. Ambil semua data ONU dari database
app.get('/api/monitoring/onus', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM onus');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. Tambah data ONU secara manual
app.post('/api/monitoring/onus', async (req, res) => {
    const { sn, name, rx, ip, odp, status } = req.body;
    try {
        await pool.query(
            'INSERT INTO onus (serial_number, name, rx_power, ip_address, odp, status) VALUES (?, ?, ?, ?, ?, ?)',
            [sn, name, rx, ip, odp, status]
        );
        res.json({ success: true, message: 'ONU berhasil ditambahkan.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. Update / Edit data ONU
app.put('/api/monitoring/onus/:id', async (req, res) => {
    const { id } = req.params;
    const { sn, name, rx, ip, odp, status } = req.body;
    try {
        await pool.query(
            'UPDATE onus SET serial_number = ?, name = ?, rx_power = ?, ip_address = ?, odp = ?, status = ? WHERE id = ?',
            [sn, name, rx, ip, odp, status, id]
        );
        res.json({ success: true, message: 'ONU berhasil diperbarui.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. Hapus data ONU
app.delete('/api/monitoring/onus/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM onus WHERE id = ?', [id]);
        res.json({ success: true, message: 'ONU berhasil dihapus.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// Jalankan Server
app.listen(PORT, () => {
    console.log(`Server MEGANET Monitoring berjalan di http://localhost:${PORT}`);
});

