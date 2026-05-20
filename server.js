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
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.redirect("/login");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    firebase: firebaseEnabled,
    discordClientIdSet: Boolean(CLIENT_ID),
    discordClientIdLast4: CLIENT_ID ? CLIENT_ID.slice(-4) : null,
    discordClientSecretSet: Boolean(CLIENT_SECRET),
    jwtSecretSet: Boolean(JWT_SECRET),
    authEnvKeys: Object.keys(process.env).filter((key) =>
      /^(DISCORD_|CLIENT_|JWT_)/.test(key)
    ),
    redirectUri: REDIRECT_URI || `${req.protocol}://${req.get("host")}/callback`,
  });
});

// =====================
// CONFIG
// =====================
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const JWT_SECRET = process.env.JWT_SECRET;

const DB_FILE = "./accounts.json";
const DOWNLOADS_DIR = "./downloads";
const ACCOUNTS_COLLECTION = "accounts";
const LEADERBOARD_COLLECTION = "leaderboard";
const PRESENCE_TTL_MS = 45 * 1000;

const launcherSessions = new Map();

const missingEnv = [];
if (!CLIENT_ID) missingEnv.push("DISCORD_CLIENT_ID");
if (!CLIENT_SECRET) missingEnv.push("DISCORD_CLIENT_SECRET");
if (!JWT_SECRET) missingEnv.push("JWT_SECRET");

if (missingEnv.length > 0) {
  console.error("Missing required environment variables: " + missingEnv.join(", "));
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
    displayName: user.global_name || user.username,
    avatar: user.avatar || null,
    token: launcherToken,
    lastLogin: Date.now(),
  };
}

function verifyLauncherToken(req) {
  const header = req.headers.authorization || "";
  const bearerToken = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearerToken || req.query.token;

  if (!token) return null;
  return jwt.verify(token, JWT_SECRET);
}

function publicAccount(account) {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName || account.username,
    avatar: account.avatar || null,
    lastLogin: account.lastLogin || null,
  };
}

function defaultLeaderboardEntry(account) {
  return {
    id: account.id,
    name: account.displayName || account.username,
    username: account.username,
    tag: "#" + String(account.id).slice(-4),
    wins: 0,
    kd: 0,
    matches: 0,
    color: "#7b2ff7",
    updatedAt: Date.now(),
  };
}

async function syncLeaderboardProfile(account) {
  if (!firebaseEnabled || !firestore) return;

  const ref = firestore.collection(LEADERBOARD_COLLECTION).doc(account.id);
  const doc = await ref.get();

  if (doc.exists) {
    await ref.set({
      id: account.id,
      name: account.displayName || account.username,
      username: account.username,
      tag: "#" + String(account.id).slice(-4),
      updatedAt: Date.now(),
    }, { merge: true });
    return;
  }

  await ref.set(defaultLeaderboardEntry(account));
}

async function saveAccount(account) {
  if (firebaseEnabled && firestore) {
    await firestore
      .collection(ACCOUNTS_COLLECTION)
      .doc(account.id)
      .set(account, { merge: true });
    await syncLeaderboardProfile(account);
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

async function getAccountById(id) {
  if (firebaseEnabled && firestore) {
    const doc = await firestore.collection(ACCOUNTS_COLLECTION).doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  return loadDB()[id] || null;
}

async function getLeaderboard() {
  if (firebaseEnabled && firestore) {
    const snapshot = await firestore
      .collection(LEADERBOARD_COLLECTION)
      .orderBy("wins", "desc")
      .limit(100)
      .get();

    return snapshot.docs.map((doc) => doc.data());
  }

  return Object.values(loadDB()).map(defaultLeaderboardEntry);
}

async function updateLeaderboardForUser(userId, stats) {
  const account = await getAccountById(userId);
  if (!account) return null;

  const entry = {
    ...defaultLeaderboardEntry(account),
    wins: Math.max(0, Number(stats.wins) || 0),
    kd: Math.max(0, Number(stats.kd) || 0),
    matches: Math.max(0, Number(stats.matches) || 0),
    updatedAt: Date.now(),
  };

  if (firebaseEnabled && firestore) {
    await firestore.collection(LEADERBOARD_COLLECTION).doc(userId).set(entry, { merge: true });
  }

  return entry;
}

function cleanExpiredSessions() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [sessionId, session] of launcherSessions.entries()) {
    if (!session.lastSeen || session.lastSeen < cutoff) {
      launcherSessions.delete(sessionId);
    }
  }
}

function getOnlineCount() {
  cleanExpiredSessions();
  return launcherSessions.size;
}

// =====================
// FORTNITE SERVICE ROUTES
// =====================
const FORTNITE_BUILD = "++Fortnite+Release-14.40-CL-14550713-Windows";
const FORTNITE_ACCOUNT_ID = "projectgalaxy000000000000000000";

function isoNow() {
  return new Date().toISOString();
}

function fortniteAccountId(req) {
  return String(
    req.params.accountId ||
    req.params.id ||
    req.query.accountId ||
    FORTNITE_ACCOUNT_ID
  ).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32) || FORTNITE_ACCOUNT_ID;
}

function fortniteProfileResponse(req) {
  const accountId = fortniteAccountId(req);
  const profileId = String(req.query.profileId || "athena");
  const rvn = Number(req.query.rvn || 0);

  return {
    profileRevision: rvn + 1,
    profileId,
    profileChangesBaseRevision: rvn,
    profileChanges: [
      {
        changeType: "fullProfileUpdate",
        profile: {
          _id: accountId,
          created: isoNow(),
          updated: isoNow(),
          rvn: rvn + 1,
          wipeNumber: 1,
          accountId,
          profileId,
          version: "project-galaxy-1",
          items: {},
          stats: {
            attributes: {
              season_num: 14,
              book_level: 1,
              accountLevel: 1,
              past_seasons: [],
              loadouts: [],
              favorite_character: "",
              favorite_backpack: "",
              favorite_pickaxe: "",
              favorite_glider: "",
              favorite_skydivecontrail: "",
              favorite_dance: [],
              favorite_itemwraps: [],
              favorite_musicpack: "",
              favorite_loadingscreen: "",
              mfa_enabled: true,
            },
          },
          commandRevision: 0,
        },
      },
    ],
    profileCommandRevision: 0,
    serverTime: isoNow(),
    responseVersion: 1,
  };
}

function fortniteToken(req) {
  const now = Math.floor(Date.now() / 1000);
  const accountId = FORTNITE_ACCOUNT_ID;
  const accessToken = jwt.sign(
    {
      app: "fortnite",
      sub: accountId,
      account_id: accountId,
      displayName: "ProjectGalaxy",
      iat: now,
    },
    JWT_SECRET || "project-galaxy-dev-secret",
    { expiresIn: "8h" }
  );

  return {
    access_token: accessToken,
    expires_in: 28800,
    expires_at: new Date(Date.now() + 28800 * 1000).toISOString(),
    token_type: "bearer",
    refresh_token: accessToken,
    refresh_expires: 28800,
    refresh_expires_at: new Date(Date.now() + 28800 * 1000).toISOString(),
    account_id: accountId,
    client_id: "project-galaxy",
    internal_client: true,
    client_service: "fortnite",
    displayName: "ProjectGalaxy",
    app: "fortnite",
    in_app_id: accountId,
    device_id: "project-galaxy-device",
  };
}

app.get(["/fortnite/api/versioncheck", "/fortnite/api/v2/versioncheck/:platform"], (req, res) => {
  const version = req.query.version || FORTNITE_BUILD;
  res.json({
    type: "NO_UPDATE",
    acceptedVersions: [version, FORTNITE_BUILD],
  });
});

app.get("/fortnite/api/game/v2/enabled_features", (req, res) => {
  res.json(["store", "battleroyale", "athena"]);
});

app.get("/lightswitch/api/service/Fortnite/status", (req, res) => {
  res.json({
    serviceInstanceId: "fortnite",
    status: "UP",
    message: "Project Galaxy online",
    maintenanceUri: null,
    overrideCatalogIds: ["a7f138b2e51945ffbfdacc1af0541053"],
    allowedActions: ["PLAY", "DOWNLOAD"],
    banned: false,
    launcherInfoDTO: {
      appName: "Fortnite",
      catalogItemId: "4fe75bbc5a674f4f9b356b5c90567da5",
      namespace: "fn",
    },
  });
});

app.get("/waitingroom/api/waitingroom", (req, res) => {
  res.status(204).end();
});

app.post("/account/api/oauth/token", (req, res) => {
  res.json(fortniteToken(req));
});

app.get("/account/api/oauth/verify", (req, res) => {
  res.json({
    token: "project-galaxy",
    session_id: "project-galaxy-session",
    token_type: "bearer",
    client_id: "project-galaxy",
    internal_client: true,
    client_service: "fortnite",
    account_id: FORTNITE_ACCOUNT_ID,
    expires_in: 28800,
    expires_at: new Date(Date.now() + 28800 * 1000).toISOString(),
    auth_method: "exchange_code",
    display_name: "ProjectGalaxy",
    app: "fortnite",
    in_app_id: FORTNITE_ACCOUNT_ID,
    device_id: "project-galaxy-device",
  });
});

app.delete("/account/api/oauth/sessions/kill", (req, res) => {
  res.status(204).end();
});

app.get("/account/api/public/account/:id", (req, res) => {
  const accountId = fortniteAccountId(req);
  res.json({
    id: accountId,
    displayName: "ProjectGalaxy",
    name: "ProjectGalaxy",
    email: "projectgalaxy@example.com",
    failedLoginAttempts: 0,
    lastLogin: isoNow(),
    numberOfDisplayNameChanges: 0,
    ageGroup: "UNKNOWN",
    headless: false,
    country: "US",
    lastName: "Galaxy",
    preferredLanguage: "en",
    canUpdateDisplayName: false,
    tfaEnabled: true,
    emailVerified: true,
    minorVerified: false,
    minorExpected: false,
    minorStatus: "NOT_MINOR",
  });
});

app.get("/account/api/public/account", (req, res) => {
  const ids = String(req.query.accountId || FORTNITE_ACCOUNT_ID).split(",");
  res.json(ids.map((id) => ({
    id: id.trim(),
    displayName: "ProjectGalaxy",
    externalAuths: {},
  })));
});

app.get("/fortnite/api/calendar/v1/timeline", (req, res) => {
  res.json({
    channels: {
      "client-matchmaking": {
        states: [],
        cacheExpire: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      "client-events": {
        states: [],
        cacheExpire: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    },
    eventsTimeOffsetHrs: 0,
    cacheIntervalMins: 60,
    currentTime: isoNow(),
  });
});

app.get("/fortnite/api/cloudstorage/system", (req, res) => {
  res.json([]);
});

app.get("/fortnite/api/cloudstorage/system/:filename", (req, res) => {
  res.type("text/plain").send("");
});

app.get("/fortnite/api/cloudstorage/user/:accountId", (req, res) => {
  res.json([]);
});

app.get("/fortnite/api/game/v2/privacy/account/:accountId", (req, res) => {
  res.json({
    accountId: fortniteAccountId(req),
    optOutOfPublicLeaderboards: false,
  });
});

app.post("/fortnite/api/game/v2/profile/:accountId/client/:operation", (req, res) => {
  res.json(fortniteProfileResponse(req));
});

app.get("/fortnite/api/game/v2/world/info", (req, res) => {
  res.json({});
});

// =====================
// LOGIN ROUTE
// =====================
app.get("/login", (req, res) => {
  if (missingEnv.length > 0) {
    return res.status(500).json({
      error: "Missing required environment variables",
      missing: missingEnv,
    });
  }

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
  if (missingEnv.length > 0) {
    return res.status(500).json({
      error: "Missing required environment variables",
      missing: missingEnv,
    });
  }

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
        displayName: user.global_name || user.username,
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
    const details = err.response?.data || { error: err.message };
    console.log("Discord login failed:", details);
    res.status(500).send(`
      <h2>Login failed</h2>
      <p>Discord rejected the authentication request.</p>
      <pre>${JSON.stringify(details, null, 2)}</pre>
      <p>Check your Render environment variables and Discord OAuth2 redirect URL.</p>
    `);
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
    const accounts = await getAccounts();
    res.json(accounts);
  } catch (err) {
    console.log("Accounts load error:", err.message);
    res.status(500).json({ error: "Failed to load accounts" });
  }
});

// =====================
// LAUNCHER DOWNLOAD ROUTES
// =====================
app.get("/download/latest", (req, res) => {
  const installerPath = `${DOWNLOADS_DIR}/Project-Galaxy-Setup.exe`;

  if (!fs.existsSync(installerPath)) {
    return res.status(404).json({
      error: "Launcher setup file is not uploaded yet",
      expectedFile: installerPath,
    });
  }

  res.download(installerPath, "Project-Galaxy-Setup.exe");
});

app.use("/downloads", express.static(DOWNLOADS_DIR));

// =====================
// PROFILE ROUTE
// =====================
app.get("/me", async (req, res) => {
  try {
    const user = verifyLauncherToken(req);
    if (!user) return res.status(401).json({ error: "Missing token" });

    const account = await getAccountById(user.id);
    res.json({
      user: publicAccount(account || user),
    });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

// =====================
// LEADERBOARD ROUTES
// =====================
app.get("/leaderboard", async (req, res) => {
  try {
    res.json({ players: await getLeaderboard() });
  } catch (err) {
    console.log("Leaderboard load error:", err.message);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

app.post("/leaderboard/me", async (req, res) => {
  try {
    const user = verifyLauncherToken(req);
    if (!user) return res.status(401).json({ error: "Missing token" });

    const entry = await updateLeaderboardForUser(user.id, req.body || {});
    if (!entry) return res.status(404).json({ error: "Account not found" });

    res.json({ player: entry });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

// =====================
// LAUNCHER PRESENCE ROUTES
// =====================
app.get("/presence/online", (req, res) => {
  res.json({ online: getOnlineCount() });
});

app.post("/presence/heartbeat", (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

  launcherSessions.set(sessionId.slice(0, 120), {
    lastSeen: Date.now(),
    ip: req.ip,
  });

  res.json({ online: getOnlineCount() });
});

app.post("/presence/leave", (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  if (sessionId) launcherSessions.delete(sessionId.slice(0, 120));
  res.json({ online: getOnlineCount() });
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
