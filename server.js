const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const fs = require("fs");
const { MongoClient } = require("mongodb");

// =====================
// FIREBASE ADMIN
// =====================
const admin = require("firebase-admin");
let firebaseEnabled = false;

try {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }
  } else if (fs.existsSync("./serviceAccountKey.json")) {
    serviceAccount = require("./serviceAccountKey.json");
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseEnabled = true;
  } else {
    console.log("Firebase disabled: FIREBASE_SERVICE_ACCOUNT is not set.");
  }
} catch (err) {
  console.log("Firebase init error:", err.message);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.redirect("/login");
});

// =====================
// CONFIG
// =====================
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1505369355331047455";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "CYlNATa1Obtc0_j5J1yiSuduzs9iLVbb";

const REDIRECT_URI = process.env.REDIRECT_URI || "https://ogfn-backend3-1.onrender.com/callback";
const JWT_SECRET = process.env.JWT_SECRET || "qwertyuiopasdfghjklzxcvbnm1234567890";

const DB_FILE = "./accounts.json";
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "ogfn_launcher";
let mongoDb = null;

if (MONGODB_URI) {
  const mongoClient = new MongoClient(MONGODB_URI);
  mongoClient
    .connect()
    .then(() => {
      mongoDb = mongoClient.db(MONGODB_DB);
      console.log("MongoDB connected: " + MONGODB_DB);
    })
    .catch((err) => {
      console.log("MongoDB error:", err.message);
    });
} else {
  console.log("MongoDB disabled: MONGODB_URI is not set.");
}

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

async function saveAccount(account) {
  const db = loadDB();
  db[account.id] = account;
  saveDB(db);

  if (mongoDb) {
    await mongoDb.collection("accounts").updateOne(
      { id: account.id },
      { $set: account },
      { upsert: true }
    );
  }
}

async function getAccounts() {
  if (mongoDb) {
    const accounts = await mongoDb.collection("accounts").find({}).toArray();
    return accounts.reduce((result, account) => {
      const { _id, ...publicAccount } = account;
      result[publicAccount.id] = publicAccount;
      return result;
    }, {});
  }

  return loadDB();
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

    const account = {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      token: launcherToken,
      lastLogin: Date.now(),
    };

    await saveAccount(account);

    // save Firebase (safe try)
    try {
      if (!firebaseEnabled) throw new Error("Firebase is not configured");
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
          window.location.href = "/fallback?token=" + encodeURIComponent(token);
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
app.get("/accounts", async (req, res) => {
  try {
    res.json(await getAccounts());
  } catch (err) {
    console.log("Accounts load error:", err.message);
    res.status(500).json({ error: "Failed to load accounts" });
  }
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
