const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const fs = require("fs");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// ROOT (Render check)
// =====================
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// =====================
// FIREBASE SAFE INIT
// =====================
let firebaseReady = false;

if (process.env.FIREBASE_KEY) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    firebaseReady = true;
    console.log("Firebase connected");
  } catch (err) {
    console.log("Firebase error:", err.message);
  }
}

// =====================
// ENV CONFIG
// =====================
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// =====================
// SIMPLE FILE DB
// =====================
const DB_FILE = "./accounts.json";

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, "{}");
    }
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.log("DB error:", err.message);
  }
}

// =====================
// LOGIN ROUTE
// =====================
app.get("/login", (req, res) => {
  const url =
    `https://discord.com/oauth2/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=identify%20email`;

  res.redirect(url);
});

// =====================
// CALLBACK ROUTE
// =====================
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("No code provided");

  try {
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const access_token = tokenRes.data.access_token;

    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const user = userRes.data;

    const launcherToken = jwt.sign(
      {
        id: user.id,
        username: user.username,
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    // SAVE LOCAL DB
    const db = loadDB();
    db[user.id] = {
      id: user.id,
      username: user.username,
      token: launcherToken,
      lastLogin: Date.now(),
    };
    saveDB(db);

    // SAVE FIREBASE (if enabled)
    if (firebaseReady) {
      await admin.firestore().collection("accounts").doc(user.id).set({
        id: user.id,
        username: user.username,
        token: launcherToken,
        lastLogin: Date.now(),
      });
    }

    // RETURN TO LAUNCHER
    res.send(`
      <script>
        const token = "${launcherToken}";
        localStorage.setItem("ogfn_token", token);
        window.location.href = "ogfn://login?token=" + token;
      </script>
    `);

  } catch (err) {
    console.log(err.message);
    res.send("Login failed");
  }
});

// =====================
// VERIFY ROUTE
// =====================
app.get("/verify", (req, res) => {
  try {
    const data = jwt.verify(req.query.token, JWT_SECRET);
    res.json({ valid: true, user: data });
  } catch {
    res.json({ valid: false });
  }
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
