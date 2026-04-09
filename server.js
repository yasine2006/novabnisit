const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'novabnisit_secret_2024_change_this';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── DATABASE ─────────────────────────────────────────────────────────────────
// En production (Railway) → utilise PostgreSQL via DATABASE_URL
// En local → utilise un fichier JSON (lowdb)

let db;

async function initDB() {
  if (process.env.DATABASE_URL) {
    // ── PostgreSQL (Railway production) ──────────────────────────────────────
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        company TEXT,
        service TEXT,
        message TEXT,
        status TEXT DEFAULT 'new',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        email TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Créer admin par défaut
    const existing = await pool.query("SELECT id FROM admins WHERE username = 'admin'");
    if (existing.rows.length === 0) {
      const hashed = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
      await pool.query(
        'INSERT INTO admins (username, password, email) VALUES ($1, $2, $3)',
        ['admin', hashed, 'admin@novabnisit.com']
      );
      console.log('✅ Admin PostgreSQL créé');
    }

    db = {
      type: 'pg',
      pool,
      async addContact({ name, email, phone, company, service, message }) {
        const { rows } = await pool.query(
          `INSERT INTO contacts (name, email, phone, company, service, message)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [name, email, phone || null, company || null, service || null, message]
        );
        return rows[0];
      },
      async getContacts() {
        const { rows } = await pool.query('SELECT * FROM contacts ORDER BY created_at DESC');
        return rows;
      },
      async updateContact(id, status) {
        const { rowCount } = await pool.query('UPDATE contacts SET status=$1 WHERE id=$2', [status, id]);
        return rowCount > 0;
      },
      async deleteContact(id) {
        const { rowCount } = await pool.query('DELETE FROM contacts WHERE id=$1', [id]);
        return rowCount > 0;
      },
      async getStats() {
        const total = (await pool.query('SELECT COUNT(*) FROM contacts')).rows[0].count;
        const newC = (await pool.query("SELECT COUNT(*) FROM contacts WHERE status='new'")).rows[0].count;
        const contacted = (await pool.query("SELECT COUNT(*) FROM contacts WHERE status='contacted'")).rows[0].count;
        const thisMonth = (await pool.query(
          "SELECT COUNT(*) FROM contacts WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())"
        )).rows[0].count;
        return { total: +total, new: +newC, contacted: +contacted, thisMonth: +thisMonth };
      },
      async getUser(username) {
        const { rows } = await pool.query('SELECT * FROM admins WHERE username=$1', [username]);
        return rows[0] || null;
      }
    };

    console.log('✅ Base de données PostgreSQL connectée');

  } else {
    // ── lowdb (développement local) ───────────────────────────────────────────
    const low = require('lowdb');
    const FileSync = require('lowdb/adapters/FileSync');
    const adapter = new FileSync(path.join(__dirname, 'database.json'));
    const ldb = low(adapter);

    ldb.defaults({ contacts: [], admins: [], nextId: 1 }).write();

    if (!ldb.get('admins').find({ username: 'admin' }).value()) {
      ldb.get('admins').push({
        id: 1, username: 'admin',
        password: bcrypt.hashSync('admin123', 10),
        email: 'admin@novabnisit.com'
      }).write();
      console.log('✅ Admin local créé : admin / admin123');
    }

    db = {
      type: 'json',
      addContact({ name, email, phone, company, service, message }) {
        const id = ldb.get('nextId').value();
        const contact = {
          id, name, email,
          phone: phone || null, company: company || null,
          service: service || null, message,
          status: 'new', created_at: new Date().toISOString()
        };
        ldb.get('contacts').push(contact).write();
        ldb.set('nextId', id + 1).write();
        return contact;
      },
      getContacts() {
        return ldb.get('contacts').orderBy('created_at', 'desc').value();
      },
      updateContact(id, status) {
        const c = ldb.get('contacts').find({ id: +id }).value();
        if (!c) return false;
        ldb.get('contacts').find({ id: +id }).assign({ status }).write();
        return true;
      },
      deleteContact(id) {
        const before = ldb.get('contacts').value().length;
        ldb.get('contacts').remove({ id: +id }).write();
        return ldb.get('contacts').value().length < before;
      },
      getStats() {
        const contacts = ldb.get('contacts').value();
        const now = new Date();
        const m = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        return {
          total: contacts.length,
          new: contacts.filter(c => c.status === 'new').length,
          contacted: contacts.filter(c => c.status === 'contacted').length,
          thisMonth: contacts.filter(c => c.created_at.startsWith(m)).length
        };
      },
      getUser(username) {
        return ldb.get('admins').find({ username }).value() || null;
      }
    };

    console.log('✅ Base de données locale (database.json) prête');
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Champs requis' });

    const admin = await db.getUser(username);
    if (!admin || !bcrypt.compareSync(password, admin.password))
      return res.status(401).json({ error: 'Identifiants incorrects' });

    const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ success: true, token, username: admin.username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/contacts', async (req, res) => {
  try {
    const { name, email, phone, company, service, message } = req.body;
    if (!name || !email || !message)
      return res.status(400).json({ error: 'Nom, email et message sont requis' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Email invalide' });

    const contact = await db.addContact({ name, email, phone, company, service, message });
    res.status(201).json({ success: true, contact });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/contacts', auth, async (_req, res) => {
  try {
    const contacts = await db.getContacts();
    res.json({ success: true, contacts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/contacts/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['new', 'contacted', 'closed'].includes(status))
      return res.status(400).json({ error: 'Statut invalide' });
    const ok = await db.updateContact(req.params.id, status);
    if (!ok) return res.status(404).json({ error: 'Contact introuvable' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/contacts/:id', auth, async (req, res) => {
  try {
    const ok = await db.deleteContact(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Contact introuvable' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', auth, async (_req, res) => {
  try {
    const stats = await db.getStats();
    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`
  ╔════════════════════════════════════════╗
  ║   🚀 NovaBnisit démarré               ║
  ║   📍 http://localhost:${PORT}              ║
  ║   💾 DB: ${process.env.DATABASE_URL ? 'PostgreSQL ☁️ ' : 'JSON local    '}         ║
  ║   🔑 Admin: admin / admin123          ║
  ╚════════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error('❌ Erreur init DB:', err);
  process.exit(1);
});
