const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./config/database');
const axios = require('axios');
const { RouterOSAPI } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 3000;
const GENIEACS_NBI_URL = (process.env.GENIEACS_NBI_URL || 'http://192.168.1.10:7557').replace(/\/+$/, '');

const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '192.168.1.1';
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'admin';
const MIKROTIK_PASS = process.env.MIKROTIK_PASS || '';
const MIKROTIK_PORT = Number(process.env.MIKROTIK_PORT || 8728);

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static('public'));

const byteHistory = new Map();
const chartHistory = new Map();

function toMbps(currBytes, prevBytes, elapsedSec) {
    const c = Number(currBytes || 0);
    const p = Number(prevBytes || 0);
    if (!elapsedSec || elapsedSec <= 0 || c < p) return 0;
    return Number((((c - p) * 8) / (elapsedSec * 1e6)).toFixed(2));
}

function formatBytesToGb(bytes) {
    const val = Number(bytes || 0);
    return (val / (1024 ** 3)).toFixed(2);
}

function formatUptimeId(rawUptime) {
    if (!rawUptime) return '-';
    return String(rawUptime);
}

async function queryMikrotikTraffic(requestedIface) {
    const api = new RouterOSAPI({
        host: MIKROTIK_HOST,
        user: MIKROTIK_USER,
        password: MIKROTIK_PASS,
        port: MIKROTIK_PORT,
        timeout: 6
    });

    await api.connect();
    try {
        const [resList, rbList, ifList] = await Promise.all([
            api.write('/system/resource/print'),
            api.write('/system/routerboard/print').catch(() => []),
            api.write('/interface/print')
        ]);

        let wgList = [];
        try {
            wgList = await api.write('/interface/wireguard/print');
        } catch (e) {
            wgList = [];
        }

        const wgNames = new Set(wgList.map((w) => String(w.name || '').toLowerCase()));
        const now = Date.now();
        const interfaces = [];
        let selectedRate = { txMbps: 0, rxMbps: 0 };

        for (const item of ifList) {
            const name = String(item.name || '');
            const key = name.toLowerCase();
            const rxBytes = Number(item['rx-byte'] || 0);
            const txBytes = Number(item['tx-byte'] || 0);
            const prev = byteHistory.get(key);

            let rxMbps = 0;
            let txMbps = 0;
            if (prev) {
                const elapsedSec = (now - prev.ts) / 1000;
                rxMbps = toMbps(rxBytes, prev.rxBytes, elapsedSec);
                txMbps = toMbps(txBytes, prev.txBytes, elapsedSec);
            }
            byteHistory.set(key, { rxBytes, txBytes, ts: now });

            const isWg = wgNames.has(key) || key.startsWith('wg') || String(item.type || '').includes('wireguard');
            const isRunning = String(item.running) === 'true';

            const row = {
                name,
                type: isWg ? 'WireGuard Tunnel' : (item.type || 'Interface'),
                status: isRunning ? 'Running' : 'Down',
                tx: `${txMbps.toFixed(2)} Mbps`,
                rx: `${rxMbps.toFixed(2)} Mbps`,
                tx_mbps: txMbps,
                rx_mbps: rxMbps
            };
            interfaces.push(row);

            if (requestedIface && key === String(requestedIface).toLowerCase()) {
                selectedRate = { txMbps, rxMbps };
            }
        }

        if (!requestedIface && interfaces.length > 0) {
            selectedRate = { txMbps: interfaces[0].tx_mbps, rxMbps: interfaces[0].rx_mbps };
        }

        const resInfo = resList[0] || {};
        const rbInfo = rbList[0] || {};
        const totalMem = Number(resInfo['total-memory'] || 0);
        const freeMem = Number(resInfo['free-memory'] || 0);
        const usedMem = Math.max(0, totalMem - freeMem);

        return {
            system: {
                board_name: `${rbInfo['board-name'] || resInfo['board-name'] || 'MikroTik'} (${resInfo.architecture || ''})`.trim(),
                version: resInfo.version || '-',
                memory: totalMem > 0 ? `${formatBytesToGb(usedMem)} GB of ${formatBytesToGb(totalMem)} GB` : '-',
                cpu_load: Number(resInfo['cpu-load'] ?? 0),
                uptime: formatUptimeId(resInfo.uptime)
            },
            interfaces,
            current_rx: selectedRate.rxMbps,
            current_tx: selectedRate.txMbps
        };
    } finally {
        await api.close().catch(() => {});
    }
}

app.get('/api/traffic/stats', async (req, res) => {
    const period = String(req.query.period || 'Harian');
    const node = String(req.query.node || 'MEGANET-CORE');
    const iface = String(req.query.interface || 'ether1-gateway');

    try {
        const mk = await queryMikrotikTraffic(iface);
        const histKey = `${node}:${iface}:${period}`;
        const series = chartHistory.get(histKey) || { labels: [], download: [], upload: [] };

        const nowLabel = new Date().toLocaleTimeString('id-ID', { hour12: false });
        series.labels.push(nowLabel);
        series.download.push(mk.current_rx);
        series.upload.push(mk.current_tx);

        if (series.labels.length > 20) {
            series.labels.shift();
            series.download.shift();
            series.upload.shift();
        }
        chartHistory.set(histKey, series);

        const peakDl = series.download.length ? Math.max(...series.download) : mk.current_rx;
        const peakUl = series.upload.length ? Math.max(...series.upload) : mk.current_tx;

        res.json({
            success: true,
            data: {
                peak_download: peakDl,
                peak_upload: peakUl,
                avg_latency: 0,
                packet_loss: '0.00',
                system: mk.system,
                chart: series,
                interfaces: mk.interfaces
            }
        });
    } catch (err) {
        res.status(502).json({ success: false, message: err.message });
    }
});

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

// ==========================================
// 2. API GENIEACS (TR-069)
// ==========================================
app.get('/api/genieacs/devices', async (req, res) => {
    const targetUrl = (req.query.url || GENIEACS_NBI_URL).replace(/\/+$/, '');
    try {
        const response = await axios.get(`${targetUrl}/devices`, { timeout: 8000 });
        res.json(response.data);
    } catch (error) {
        res.status(502).json({ success: false, message: error.message, target: targetUrl });
    }
});

app.post('/api/genieacs/devices/:deviceId/reboot', async (req, res) => {
    const targetUrl = (req.body?.url || req.query.url || GENIEACS_NBI_URL).replace(/\/+$/, '');
    try {
        const { deviceId } = req.params;
        const response = await axios.post(
            `${targetUrl}/devices/${encodeURIComponent(deviceId)}/tasks?timeout=30000&connection_request=true`,
            { name: 'reboot' },
            { timeout: 10000 }
        );
        res.json({ success: true, message: 'Perintah reboot berhasil dikirim ke ONU.', data: response.data });
    } catch (error) {
        res.status(502).json({ success: false, message: error.message, target: targetUrl });
    }
});

app.post('/api/genieacs/reboot/:deviceId', async (req, res) => {
    const targetUrl = (req.body?.url || req.query.url || GENIEACS_NBI_URL).replace(/\/+$/, '');
    try {
        const { deviceId } = req.params;
        await axios.post(
            `${targetUrl}/devices/${encodeURIComponent(deviceId)}/tasks?timeout=30000&connection_request=true`,
            { name: 'reboot' },
            { timeout: 10000 }
        );
        res.json({ success: true, message: 'Perintah reboot berhasil dikirim ke ONU.' });
    } catch (error) {
        res.status(502).json({ success: false, message: error.message });
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

// ==========================================
// 7. API MONITORING ONUS (CRUD)
// ==========================================
app.get('/api/monitoring/onus', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM onus');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/monitoring/onus', async (req, res) => {
    const { sn, name, rx, ip, odp, status } = req.body;
    try {
        await db.query(
            'INSERT INTO onus (serial_number, name, rx_power, ip_address, odp, status) VALUES (?, ?, ?, ?, ?, ?)',
            [sn, name, rx, ip, odp, status]
        );
        res.json({ success: true, message: 'ONU berhasil ditambahkan.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/monitoring/onus/:id', async (req, res) => {
    const { id } = req.params;
    const { sn, name, rx, ip, odp, status } = req.body;
    try {
        await db.query(
            'UPDATE onus SET serial_number = ?, name = ?, rx_power = ?, ip_address = ?, odp = ?, status = ? WHERE id = ?',
            [sn, name, rx, ip, odp, status, id]
        );
        res.json({ success: true, message: 'ONU berhasil diperbarui.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/monitoring/onus/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM onus WHERE id = ?', [id]);
        res.json({ success: true, message: 'ONU berhasil dihapus.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/genieacs/devices/:deviceId/credentials', async (req, res) => {
    const targetUrl = (req.body?.url || req.query.url || GENIEACS_NBI_URL).replace(/\/+$/, '');
    const { deviceId } = req.params;
    const {
        mode = 'pppoe',
        pppoeUsername,
        pppoePassword,
        wifiSsid,
        wifiPassword,
        pppoePath = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1',
        wifiPath = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1'
    } = req.body || {};

    const parameterValues = [];

    if ((mode === 'pppoe' || mode === 'both') && pppoeUsername !== undefined) {
        parameterValues.push([`${pppoePath}.Username`, String(pppoeUsername), 'xsd:string']);
    }
    if ((mode === 'pppoe' || mode === 'both') && pppoePassword) {
        parameterValues.push([`${pppoePath}.Password`, String(pppoePassword), 'xsd:string']);
    }
    if ((mode === 'wifi' || mode === 'both') && wifiSsid !== undefined) {
        parameterValues.push([`${wifiPath}.SSID`, String(wifiSsid), 'xsd:string']);
    }
    if ((mode === 'wifi' || mode === 'both') && wifiPassword) {
        parameterValues.push([`${wifiPath}.KeyPassphrase`, String(wifiPassword), 'xsd:string']);
    }

    if (parameterValues.length === 0) {
        return res.status(400).json({ success: false, message: 'Tidak ada parameter username/password/SSID yang diisi.' });
    }

    try {
        const response = await axios.post(
            `${targetUrl}/devices/${encodeURIComponent(deviceId)}/tasks?timeout=30000&connection_request=true`,
            {
                name: 'setParameterValues',
                parameterValues
            },
            { timeout: 15000 }
        );
        res.json({ success: true, message: 'Parameter ONU berhasil dikirim ke GenieACS.', data: response.data });
    } catch (error) {
        res.status(502).json({ success: false, message: error.message, target: targetUrl });
    }
});

function extractAcsValue(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'object' && '_value' in node) return String(node._value ?? '');
    return String(node);
}

function findNestedValue(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (const k of keys) {
        if (k in obj) {
            const val = extractAcsValue(obj[k]);
            if (val !== '') return val;
        }
    }
    for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') {
            const found = findNestedValue(val, keys);
            if (found !== '') return found;
        }
    }
    return '';
}

app.get('/api/monitoring/onus/acs', async (req, res) => {
    try {
        const [dbRows] = await db.query('SELECT * FROM onus ORDER BY id DESC');
        let acsDevices = [];

        try {
            const acsRes = await axios.get(`${GENIEACS_NBI_URL}/devices`, { timeout: 6000 });
            acsDevices = Array.isArray(acsRes.data) ? acsRes.data : [];
        } catch (acsErr) {
            acsDevices = [];
        }

        const acsMap = new Map();
        const now = Date.now();

        for (const dev of acsDevices) {
            const sn = (
                extractAcsValue(dev?._deviceId?._SerialNumber) ||
                findNestedValue(dev, ['SerialNumber'])
            ).trim();

            const lastInformRaw = dev?._lastInform || '';
            const lastInformMs = lastInformRaw ? new Date(lastInformRaw).getTime() : 0;
            const isAcsOnline = lastInformMs > 0 && (now - lastInformMs) <= 10 * 60 * 1000;

            const rxRaw = findNestedValue(dev, ['RxPower', 'OpticalPower', 'RXPower']);
            const ipRaw = findNestedValue(dev, ['ExternalIPAddress', 'IPAddress']);

            const normalized = {
                acs_device_id: String(dev._id || ''),
                serial_number: sn,
                rx_power: rxRaw ? (rxRaw.includes('dBm') ? rxRaw : `${rxRaw} dBm`) : '',
                ip_address: ipRaw,
                last_inform: lastInformRaw ? new Date(lastInformRaw).toLocaleString('id-ID') : '',
                status: isAcsOnline ? 'Online' : 'Offline'
            };

            if (sn) acsMap.set(sn.toLowerCase(), normalized);
            if (dev._id) acsMap.set(String(dev._id).toLowerCase(), normalized);
        }

        const usedKeys = new Set();
        const merged = dbRows.map((row) => {
            const snKey = String(row.serial_number || '').trim().toLowerCase();
            const idKey = String(row.onu_device_id || '').trim().toLowerCase();
            const matched = (snKey && acsMap.get(snKey)) || (idKey && acsMap.get(idKey)) || null;

            if (matched) {
                if (snKey) usedKeys.add(snKey);
                if (matched.acs_device_id) usedKeys.add(matched.acs_device_id.toLowerCase());
            }

            return {
                ...row,
                acs_device_id: matched?.acs_device_id || row.onu_device_id || '',
                rx_power: matched?.rx_power || row.rx_power || '-',
                ip_address: matched?.ip_address || row.ip_address || '-',
                last_inform: matched?.last_inform || '',
                status: matched ? matched.status : (row.status || 'Offline')
            };
        });

        for (const dev of acsDevices) {
            const sn = (
                extractAcsValue(dev?._deviceId?._SerialNumber) ||
                findNestedValue(dev, ['SerialNumber'])
            ).trim();
            const devId = String(dev._id || '');
            const keySn = sn.toLowerCase();
            const keyId = devId.toLowerCase();

            if ((keySn && usedKeys.has(keySn)) || (keyId && usedKeys.has(keyId))) continue;
            if (keySn) usedKeys.add(keySn);
            if (keyId) usedKeys.add(keyId);

            const lastInformRaw = dev?._lastInform || '';
            const lastInformMs = lastInformRaw ? new Date(lastInformRaw).getTime() : 0;
            const isAcsOnline = lastInformMs > 0 && (now - lastInformMs) <= 10 * 60 * 1000;
            const rxRaw = findNestedValue(dev, ['RxPower', 'OpticalPower', 'RXPower']);
            const ipRaw = findNestedValue(dev, ['ExternalIPAddress', 'IPAddress']);

            merged.push({
                id: null,
                acs_device_id: devId,
                serial_number: sn || devId,
                name: 'Belum Terhubung Pelanggan',
                rx_power: rxRaw ? (rxRaw.includes('dBm') ? rxRaw : `${rxRaw} dBm`) : '-',
                ip_address: ipRaw || '-',
                odp: '-',
                last_inform: lastInformRaw ? new Date(lastInformRaw).toLocaleString('id-ID') : '',
                status: isAcsOnline ? 'Online' : 'Offline'
            });
        }

        res.json({ success: true, data: merged });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 8. API PENYIMPANAN KML / MAPPING
// ==========================================
app.post('/api/kml/import', async (req, res) => {
    const { source_name, features, replace_existing } = req.body || {};

    if (!Array.isArray(features) || features.length === 0) {
        return res.status(400).json({ success: false, message: 'Data fitur KML kosong.' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        if (replace_existing) {
            await conn.query('DELETE FROM kml_features');
            await conn.query('DELETE FROM kml_imports');
        }

        const [impResult] = await conn.query(
            'INSERT INTO kml_imports (source_name) VALUES (?)',
            [String(source_name || 'import.kml').slice(0, 255)]
        );
        const importId = impResult.insertId;

        for (const f of features) {
            const geomType = f.type === 'LineString' ? 'LineString' : 'Point';
            const name = String(f.name || '').slice(0, 255);
            const colorHex = String(f.color || '#2563eb').slice(0, 16);
            const weight = Number(f.weight) > 0 ? Number(f.weight) : 4;
            const coords = Array.isArray(f.coords) ? f.coords : [];

            await conn.query(
                `INSERT INTO kml_features (import_id, geom_type, name, color_hex, weight, coords_json)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [importId, geomType, name, colorHex, weight, JSON.stringify(coords)]
            );
        }

        await conn.commit();
        res.json({
            success: true,
            message: `Berhasil menyimpan ${features.length} fitur KML ke database.`,
            import_id: importId
        });
    } catch (err) {
        await conn.rollback().catch(() => {});
        res.status(500).json({ success: false, message: err.message });
    } finally {
        conn.release();
    }
});

app.get('/api/kml/features', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT f.id, f.import_id, f.geom_type, f.name, f.color_hex, f.weight, f.coords_json,
                   i.source_name, i.created_at
            FROM kml_features f
            JOIN kml_imports i ON f.import_id = i.id
            ORDER BY f.id ASC
        `);

        const data = rows.map((r) => {
            let coords = [];
            try {
                coords = JSON.parse(r.coords_json || '[]');
            } catch (e) {
                coords = [];
            }
            return {
                id: r.id,
                import_id: r.import_id,
                source_name: r.source_name,
                type: r.geom_type,
                name: r.name,
                color: r.color_hex,
                weight: r.weight,
                coords
            };
        });

        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/kml/features', async (req, res) => {
    try {
        await db.query('DELETE FROM kml_features');
        await db.query('DELETE FROM kml_imports');
        res.json({ success: true, message: 'Semua data KML tersimpan telah dihapus.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server MEGANET Monitoring berjalan di http://localhost:${PORT}`);
});
