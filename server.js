const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const fs = require("fs");

// =====================
// FIREBASE ADMIN
// =====================
const admin = require("firebase-admin");
let firebaseEnabled = false;
let firestore = null;

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
    firestore = admin.firestore();
    firebaseEnabled = true;
  } else {
    console.log("Firebase disabled: FIREBASE_SERVICE_ACCOUNT is not set.");
  }
} catch (err) {
  console.log("Firebase init error:", err.message);
}

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "OGFN backend",
    endpoints: ["/login", "/callback", "/verify", "/accounts", "/health"],
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    firebase: firebaseEnabled,
  });
});

// =====================
// CONFIG
// =====================
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const JWT_SECRET = process.env.JWT_SECRET;

const DB_FILE = "./accounts.json";
const ACCOUNTS_COLLECTION = "accounts";

const REQUIRED_ENV = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "JWT_SECRET"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error("Missing required environment variables: " + missingEnv.join(", "));
  process.exit(1);
}

function getRedirectUri(req) {
  if (REDIRECT_URI) return REDIRECT_URI;
  return `${req.protocol}://${req.get("host")}/callback`;
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

function accountPayload(user, launcherToken) {
  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar || null,
    token: launcherToken,
    lastLogin: Date.now(),
  };
}

async function saveAccount(account) {
  if (firebaseEnabled && firestore) {
    await firestore
      .collection(ACCOUNTS_COLLECTION)
      .doc(account.id)
      .set(account, { merge: true });
    return;
  }

  const db = loadDB();
  db[account.id] = account;
  saveDB(db);
}

async function getAccounts() {
  if (firebaseEnabled && firestore) {
    const snapshot = await firestore.collection(ACCOUNTS_COLLECTION).get();
    const accounts = {};

    snapshot.forEach((doc) => {
      accounts[doc.id] = doc.data();
    });

    return accounts;
  }

  return loadDB();
}

// =====================
// LOGIN ROUTE
// =====================
app.get("/login", (req, res) => {
  const redirectUri = getRedirectUri(req);
  const url =
    `https://discord.com/oauth2/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=identify%20email`;

  res.redirect(url);
});

// =====================
// CALLBACK ROUTE
// =====================
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  const redirectUri = getRedirectUri(req);

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
        redirect_uri: redirectUri,
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

    await saveAccount(accountPayload(user, launcherToken));

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
