const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const fs = require("fs");

// =====================
// FIREBASE ADMIN
// =====================
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// CONFIG
// =====================
const CLIENT_ID = "1505369355331047455";
const CLIENT_SECRET = "CYlNATa1Obtc0_j5J1yiSuduzs9iLVbb";

const REDIRECT_URI = "http://localhost:3000/callback";
const JWT_SECRET = "qwertyuiopasdfghjklzxcvbnm1234567890";

const DB_FILE = "./accounts.json";

// =====================
// DB FUNCTIONS
// =====================
function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (err) {
    console.log("DB load error:", err.message);
    return {};
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.log("DB save error:", err.message);
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
    // get discord token
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const access_token = tokenRes.data.access_token;

    // get user
    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    const user = userRes.data;

    // create JWT
    const launcherToken = jwt.sign(
      {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    // save local DB
    const db = loadDB();

    db[user.id] = {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      token: launcherToken,
      lastLogin: Date.now(),
    };

    saveDB(db);

    // save Firebase (safe try)
    try {
      await admin.firestore().collection("accounts").doc(user.id).set({
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        token: launcherToken,
        lastLogin: Date.now(),
      });
    } catch (e) {
      console.log("Firebase error:", e.message);
    }

    // redirect to launcher
    res.send(`
      <script>
        const token = "${launcherToken}";

        localStorage.setItem("ogfn_token", token);

        window.location.href = "ogfn://login?token=" + token;

        setTimeout(() => {
          window.location.href = "http://localhost:3000/fallback?token=" + token;
        }, 2000);
      </script>
    `);

  } catch (err) {
    console.log(err.response?.data || err.message);
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
// ACCOUNTS ROUTE
// =====================
app.get("/accounts", (req, res) => {
  const db = loadDB();
  res.json(db);
});

// =====================
// FALLBACK ROUTE
// =====================
app.get("/fallback", (req, res) => {
  res.send(`
    <h2>Login complete</h2>
    <p>You can now close this page and open the launcher.</p>
    <script>
      localStorage.setItem("ogfn_token", "${req.query.token}");
    </script>
  `);
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("SERVER STARTING...");
  console.log("Running on port " + PORT);
});