// evflight — C++/SDL2 leg of V_e (pron. "vee-sub-e"), the Escape Velocity
// engine reimplementation. (V_e: the physics symbol for escape velocity —
// and EV backwards.)
//
// Feature parity with flight_template.html (the browser leg): Game Panel
// HUD (PICT 128), targeting/hails, fog-of-war galaxy map, hyperjump,
// landing screen with landscape + commodity exchange / outfitter /
// shipyard in the classic grid layout, player economy state.
//
// The engine-core functions (ev*) MUST mirror engine/core.js — see
// engine/ENGINE_SPEC.md; engine/check_traces.js proves they agree.
//
// Build:  make          (needs libsdl2-dev; stb/json/font8x8 are vendored)
// Run:    ./evflight --root ..
// Test:   SDL_VIDEODRIVER=dummy ./evflight --root .. --frames 90 --screenshot out.png
//         plus parity flags: --map --dest N --jump --land --exchange
//         --outfitter --shipyard --tab --nav --thrust --trace scenario.json

#include <SDL.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <functional>
#include <list>
#include <map>
#include <random>
#include <set>
#include <string>
#include <vector>

#include "vendor/json.hpp"
#define STB_IMAGE_IMPLEMENTATION
#include "vendor/stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "vendor/stb_image_write.h"
#include "vendor/font8x8_basic.h"

using json = nlohmann::json;

/* ================= tunables (mirror engine/core.js) ================= */

constexpr int    FPS = 30;
constexpr double kMaxSpeedDiv = 100.0;   // Speed -> px/frame
constexpr double kAccelDiv    = 9000.0;  // Accel -> px/frame²
constexpr int    JUMP_FUEL = 100, JUMP_STREAK_FRAMES = 30;
constexpr double ARRIVE_DIST = 700, LAND_DIST = 60, LAND_SPEED = 0.9;
const double PRICE_MULT_LOW = 0.80, PRICE_MULT_MED = 1.00, PRICE_MULT_HIGH = 1.25;

static double d2r(double d) { return d * M_PI / 180.0; }
static double norm360(double d) { d = std::fmod(d, 360.0); return d < 0 ? d + 360 : d; }

/* ================= entities & engine core ================= */

struct Spob; // fwd

struct Weapon { int id{}; const json* rec = nullptr; int n = 1, cool = 0; };

struct Entity {
  int shipId{}; double x{}, y{}, vx{}, vy{}, heading{};
  double maxSpeed{}, accel{}, turn{};
  bool thrusting = false;
  int dudeId = -1, govt = -1;
  const Spob* target = nullptr;
  enum { CRUISE, BRAKE, LANDING } state = CRUISE;
  double fade = 1.0;
  /* combat */
  double shields = 0, shieldMax = 0, armor = 0, armorMax = 0;
  double disableFrac = 1.0 / 3.0, mass = 50;
  int shieldT = 0, shieldRe = 0, deathDelay = 30, deathT = -1, aiType = 0;
  bool disabled = false, hostile = false, fleeing = false;
  std::vector<Weapon> weapons;
  std::map<int, int> pools;    // ammo pools: 128+AmmoType -> rounds
  std::map<int, int> poolCap;  // pool capacity (stock AmmoLoad + ammo-outfit Max)
  int selSecondary = -1;      // weapon id
};

static std::mt19937 rng(std::random_device{}());
static double frand() { return std::uniform_real_distribution<>(0, 1)(rng); }

/* ---- engine core: MUST mirror engine/core.js (golden-traced) ---- */

struct Controls { bool left = false, right = false, retro = false, thrust = false; };

static void evThrust(Entity& s) {
  s.vx += std::sin(d2r(s.heading)) * s.accel;
  s.vy -= std::cos(d2r(s.heading)) * s.accel;
  double v = std::hypot(s.vx, s.vy);
  if (v > s.maxSpeed) { s.vx *= s.maxSpeed / v; s.vy *= s.maxSpeed / v; }
  s.thrusting = true;
}
static bool evSteer(Entity& s, double desired) {
  double diff = norm360(desired - s.heading);
  if (diff > 180) diff -= 360;
  s.heading = norm360(s.heading + std::clamp(diff, -s.turn, s.turn));
  return std::abs(diff) < s.turn * 1.5;
}
static double evRetro(const Entity& s) { return norm360(std::atan2(-s.vx, s.vy) * 180 / M_PI); }
static double evBearing(double dx, double dy) { return norm360(std::atan2(dx, -dy) * 180 / M_PI); }
static void evIntegrate(Entity& s) { s.x += s.vx; s.y += s.vy; }

static void evStepPlayer(Entity& s, Controls c) {
  s.thrusting = false;
  if (c.left)  s.heading = norm360(s.heading - s.turn);
  if (c.right) s.heading = norm360(s.heading + s.turn);
  if (c.retro) evSteer(s, evRetro(s));
  if (c.thrust) evThrust(s);
  evIntegrate(s);
}

static bool evStepTrader(Entity& s, bool hasTarget, double tx, double ty) {
  s.thrusting = false;
  if (!hasTarget) { evIntegrate(s); return true; }
  double dx = tx - s.x, dy = ty - s.y;
  double dist = std::hypot(dx, dy), speed = std::hypot(s.vx, s.vy);
  // brake distance + coast while turning 180° to retrograde + pad
  double stopDist = speed * speed / (2 * s.accel) + speed * (180 / s.turn) + 40;
  if (s.state == Entity::CRUISE) {
    bool aligned = evSteer(s, evBearing(dx, dy));
    if (dist > stopDist) { if (aligned) evThrust(s); }
    else s.state = Entity::BRAKE;
  } else if (s.state == Entity::BRAKE) {
    bool aligned = evSteer(s, evRetro(s));
    if (speed > 0.15) { if (aligned) evThrust(s); }
    else if (dist < 80) s.state = Entity::LANDING;
    else s.state = Entity::CRUISE;
  } else {
    s.fade -= 0.02;
    if (s.fade <= 0) return false;
  }
  evIntegrate(s);
  return true;
}

static bool evStepJumpEngage(Entity& s, double mapBearing) {
  evSteer(s, mapBearing);
  evThrust(s);
  evIntegrate(s);
  double diff = norm360(mapBearing - s.heading);
  if (diff > 180) diff -= 360;
  return std::abs(diff) <= s.turn && std::hypot(s.vx, s.vy) >= 0.95 * s.maxSpeed;
}
static void evPlaceAtArrival(Entity& s, double inBearing) {
  double b = d2r(inBearing);
  s.x = -std::sin(b) * ARRIVE_DIST;
  s.y = std::cos(b) * ARRIVE_DIST;
  s.heading = norm360(inBearing);
  s.vx = std::sin(b) * s.maxSpeed;
  s.vy = -std::cos(b) * s.maxSpeed;
}
static void evPlaceAtTakeoff(Entity& s, double px, double py) {
  s.x = px; s.y = py - 40; s.heading = 0; s.vx = 0; s.vy = -0.4;
}

/* ---- combat core: MUST mirror engine/core.js (spec: "Combat") ---- */

constexpr double HOMING_TURN = 3.0;
constexpr int ROCKET_ACCEL_DIV = 15;

struct Shot {
  int guidance{}; double x{}, y{}, vx{}, vy{}, heading{}, speed{};
  double massDmg{}, energyDmg{}, impact{}, proxRadius{};
  int life{}, graphic = -1, explodType = -1;
  Entity* owner = nullptr; Entity* homing = nullptr;
};

static Shot evMakeShot(const json& rec, const Entity& sh, double aim) {
  int g = (int)rec["Guidance"].get<double>();
  bool ff = g == 5;
  double heading = ff ? sh.heading : norm360(aim);
  double sp = rec["Speed"].get<double>() / 100.0;
  double mv = (ff || g == 6) ? 0 : sp;
  Shot s;
  s.guidance = g; s.x = sh.x; s.y = sh.y; s.heading = heading;
  s.vx = sh.vx * (ff ? 0.8 : 1) + std::sin(d2r(heading)) * mv;
  s.vy = sh.vy * (ff ? 0.8 : 1) - std::cos(d2r(heading)) * mv;
  s.speed = sp;
  s.life = (int)rec["Count"].get<double>();
  s.massDmg = rec.value("MassDmg", 0.0); s.energyDmg = rec.value("EnergyDmg", 0.0);
  s.impact = rec.value("Impact", 0.0); s.proxRadius = rec.value("ProxRadius", 0.0);
  s.graphic = (int)rec.value("Graphic", -1.0);
  s.explodType = (int)rec.value("ExplodType", -1.0);
  return s;
}

static bool evStepShot(Shot& s, const Entity* t) {
  if ((s.guidance == 1 || s.guidance == 2) && t) {
    double diff = norm360(evBearing(t->x - s.x, t->y - s.y) - s.heading);
    if (diff > 180) diff -= 360;
    s.heading = norm360(s.heading + std::clamp(diff, -HOMING_TURN, HOMING_TURN));
    s.vx = std::sin(d2r(s.heading)) * s.speed;
    s.vy = -std::cos(d2r(s.heading)) * s.speed;
  } else if (s.guidance == 6) {
    double acc = s.speed / ROCKET_ACCEL_DIV;
    s.vx += std::sin(d2r(s.heading)) * acc;
    s.vy -= std::cos(d2r(s.heading)) * acc;
    double v = std::hypot(s.vx, s.vy);
    if (v > s.speed) { s.vx *= s.speed / v; s.vy *= s.speed / v; }
  }
  s.x += s.vx; s.y += s.vy;
  return --s.life > 0;
}

enum class Hit { SHIELDED, HIT, DISABLED, DESTROYED };
static Hit evApplyDamage(Entity& st, double massDmg, double energyDmg) {
  bool up = st.shields > 0;
  double dmg = std::max(1.0, up ? massDmg / 4 + energyDmg : massDmg + energyDmg / 4);
  if (up) { st.shields = std::max(0.0, st.shields - dmg); return Hit::SHIELDED; }
  st.armor -= dmg;
  if (st.armor <= 0) return Hit::DESTROYED;
  if (st.armor <= st.armorMax * st.disableFrac) return Hit::DISABLED;
  return Hit::HIT;
}

static void evStepShields(Entity& st, double mx, int re) {
  if (st.shields >= mx || re <= 0) return;
  if (++st.shieldT >= re) { st.shieldT = 0; st.shields = std::min(mx, st.shields + mx / 100); }
}

static void evStepWarship(Entity& s, double ex, double ey, bool& aligned, double& dist) {
  dist = std::hypot(ex - s.x, ey - s.y);
  aligned = evSteer(s, evBearing(ex - s.x, ey - s.y));
  if ((dist > 260 && aligned) || dist < 120) evThrust(s);
  evIntegrate(s);
}
static void evStepFlee(Entity& s, double ex, double ey) {
  bool aligned = evSteer(s, norm360(evBearing(ex - s.x, ey - s.y) + 180));
  if (aligned) evThrust(s);
  evIntegrate(s);
}

/* ================= golden-trace mode ================= */

static int runTrace(const std::string& path) {
  std::ifstream f(path);
  if (!f) { std::fprintf(stderr, "cannot open %s\n", path.c_str()); return 1; }
  json sc = json::parse(f);
  const int frames = sc["frames"], every = sc["sampleEvery"];
  struct TEnt { Entity e; json script; std::string kind;
                bool active = true, hasTarget = false; double tx = 0, ty = 0; };
  std::vector<TEnt> ents;
  for (auto& je : sc["entities"]) {
    TEnt t;
    auto& st = je["stats"];
    t.e.maxSpeed = st["Speed"].get<double>() / kMaxSpeedDiv;
    t.e.accel = st["Accel"].get<double>() / kAccelDiv;
    t.e.turn = st["Maneuver"].get<double>();
    t.e.x = je["x"]; t.e.y = je["y"];
    t.e.heading = norm360(je["heading"].get<double>());
    t.e.shields = t.e.shieldMax = st.value("Shield", 0.0);
    t.e.armor = t.e.armorMax = st.value("Armor", 0.0);
    t.e.mass = st.value("Mass", 50.0);
    t.e.shieldRe = (int)st.value("ShieldRe", 0.0);
    t.kind = je["kind"];
    if (je.contains("script")) t.script = je["script"];
    if (je.contains("target")) { t.hasTarget = true; t.tx = je["target"]["x"]; t.ty = je["target"]["y"]; }
    ents.push_back(std::move(t));
  }
  constexpr double TRACE_HIT_RADIUS = 12;
  struct TShot { Shot s; int ownerIdx, homingIdx; };
  std::vector<TShot> shots;
  json samples = json::array();
  auto sample = [&](int fr) {
    json list = json::array();
    for (auto& t : ents)
      list.push_back({{"x", t.e.x}, {"y", t.e.y}, {"vx", t.e.vx}, {"vy", t.e.vy},
                      {"heading", t.e.heading}, {"shields", t.e.shields}, {"armor", t.e.armor}});
    json sl = json::array();
    for (auto& sh : shots) sl.push_back({{"x", sh.s.x}, {"y", sh.s.y}});
    samples.push_back({{"frame", fr}, {"entities", list}, {"shots", sl}});
  };
  sample(0);
  for (int fr = 1; fr <= frames; fr++) {
    for (auto& t : ents) {
      if (t.kind == "player") {
        Controls c;
        for (auto& seg : t.script)
          if (fr <= seg["until"].get<int>()) {
            c.left = seg.value("left", false);   c.right = seg.value("right", false);
            c.retro = seg.value("retro", false); c.thrust = seg.value("thrust", false);
            break;
          }
        evStepPlayer(t.e, c);
      } else if (t.active) t.active = evStepTrader(t.e, t.hasTarget, t.tx, t.ty);
    }
    if (sc.contains("shots"))
      for (auto& scs : sc["shots"])
        if (scs["frame"].get<int>() == fr) {
          TShot ts{ evMakeShot(scs["weapon"], ents[scs["shooter"].get<int>()].e,
                               scs["aim"].get<double>()),
                    scs["shooter"].get<int>(), (int)scs.value("homingTarget", -1.0) };
          shots.push_back(ts);
        }
    for (size_t i = 0; i < shots.size();) {
      TShot& ts = shots[i];
      bool alive = evStepShot(ts.s, ts.homingIdx >= 0 ? &ents[ts.homingIdx].e : nullptr);
      bool hit = false;
      for (size_t k = 0; k < ents.size(); k++) {
        if ((int)k == ts.ownerIdx) continue;
        Entity& v = ents[k].e;
        if (std::hypot(v.x - ts.s.x, v.y - ts.s.y) <
            std::max(ts.s.proxRadius, TRACE_HIT_RADIUS)) {
          evApplyDamage(v, ts.s.massDmg, ts.s.energyDmg);
          double kick = ts.s.impact / (10 * v.mass);
          v.vx += std::sin(d2r(ts.s.heading)) * kick;
          v.vy -= std::cos(d2r(ts.s.heading)) * kick;
          hit = true;
          break;
        }
      }
      if (hit || !alive) shots.erase(shots.begin() + i);
      else i++;
    }
    for (auto& t : ents) evStepShields(t.e, t.e.shieldMax, t.e.shieldRe);
    if (fr % every == 0) sample(fr);
  }
  std::printf("%s\n", json({{"samples", samples}}).dump().c_str());
  return 0;
}

/* ================= game data ================= */

struct Spob {
  int id{}, type{}, techLevel{}, custPic = -1, st1 = -1, st2 = -1, st3 = -1;
  double x{}, y{};
  bool canLand = true, exchange = false, outfitter = false, shipyard = false,
       bar = false, uninhabited = false;
  std::string name, meta, landDesc;
  std::string prices[6]; // "", "low", "medium", "high"
};

static std::string asciify(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size();) {
    unsigned char c = s[i];
    if (c < 0x80) { out += (char)c; i++; }
    else if ((c & 0xE0) == 0xC0) { out += '\''; i += 2; }
    else if ((c & 0xF0) == 0xE0) { out += '\''; i += 3; }
    else i += 4;
  }
  return out;
}
static std::string commas(long long v) {
  std::string s = std::to_string(v), out;
  int c = 0;
  for (int i = (int)s.size() - 1; i >= 0; i--) {
    out += s[i];
    if (++c % 3 == 0 && i > 0 && s[i - 1] != '-') out += ',';
  }
  std::reverse(out.begin(), out.end());
  return out;
}

struct GameData {
  json db;
  std::string root;
  static GameData load(const std::string& root) {
    GameData g; g.root = root;
    std::ifstream f(root + "/evdata.json");
    if (!f) { std::fprintf(stderr, "cannot open evdata.json (run evexport.js --semantic)\n"); std::exit(1); }
    g.db = json::parse(f);
    std::ifstream mf(root + "/evassets/manifest.json");
    if (!mf) { std::fprintf(stderr, "cannot open evassets/manifest.json\n"); std::exit(1); }
    g.man = json::parse(mf);
    return g;
  }
  json man;
  // nlohmann's const operator[] asserts on missing keys — always use find()
  static const json& jnull() { static const json n; return n; }
  const json& rec(const char* type, int id) const {
    auto& t = db["types"][type];
    auto it = t.find(std::to_string(id));
    return it == t.end() ? jnull() : *it;
  }
  bool has(const char* type, int id) const { return !rec(type, id).is_null(); }
  const json& ship(int id) const { return rec("ship", id); }
  const json& outf(int id) const { return rec("outf", id); }
  const json* strlist(int listId) const {
    auto it = db["strings"].find(std::to_string(listId));
    return it == db["strings"].end() ? nullptr : &*it;
  }
  std::string str(int listId, int idx) const {
    const json* l = strlist(listId);
    if (!l || idx < 0 || idx >= (int)(*l)["list"].size()) return "";
    return asciify((*l)["list"][idx].get<std::string>());
  }
  std::string randStr(int listId) const {
    const json* l = strlist(listId);
    if (!l) return "";
    std::vector<std::string> ok;
    for (auto& s : (*l)["list"]) {
      std::string v = s.get<std::string>();
      if (!v.empty() && v != "*") ok.push_back(asciify(v));
    }
    return ok.empty() ? "" : ok[(size_t)(frand() * ok.size())];
  }
};

static const char* COMMODITY_KEYS[6] = { "food", "industrial", "medical", "luxury", "metal", "equipment" };

static std::vector<Spob> spobsOf(const GameData& g, int systId) {
  std::vector<Spob> out;
  for (auto& [id, p] : g.db["types"]["spob"].items()) {
    if (p["System"].get<int>() != systId) continue;
    Spob sp;
    sp.id = std::stoi(id);
    sp.name = p["name"].is_string() ? asciify(p["name"].get<std::string>()) : "spob " + id;
    sp.x = p["xPos"]; sp.y = p["yPos"]; sp.type = p["Type"];
    sp.techLevel = p["TechLevel"]; sp.custPic = p["CustPicID"];
    sp.st1 = p["SpecialTech1"]; sp.st2 = p["SpecialTech2"]; sp.st3 = p["SpecialTech3"];
    if (p.contains("$sem")) {
      auto& m = p["$sem"];
      sp.canLand = m["canLand"]; sp.exchange = m["commodityExchange"];
      sp.outfitter = m["outfitter"]; sp.shipyard = m["shipyard"];
      sp.bar = m["bar"]; sp.uninhabited = m["uninhabited"];
      std::string meta;
      if (m["stellarType"].is_string()) {
        meta = m["stellarType"].get<std::string>();
        meta.erase(std::remove_if(meta.begin(), meta.end(),
          [](char c) { return c == '(' || c == ')'; }), meta.end());
      }
      if (m["govt"].is_string()) meta += (meta.empty() ? "" : " - ") + m["govt"].get<std::string>();
      sp.meta = asciify(meta);
      // $sem.prices omits commodities the spob doesn't trade — must use find
      auto& pr = m["prices"];
      for (int i = 0; i < 6; i++) {
        auto it = pr.find(COMMODITY_KEYS[i]);
        if (it != pr.end() && it->is_string()) sp.prices[i] = it->get<std::string>();
      }
    }
    auto dit = g.db["types"]["desc"].find(id);
    if (dit != g.db["types"]["desc"].end() && (*dit)["Description"].is_string())
      sp.landDesc = asciify((*dit)["Description"].get<std::string>());
    out.push_back(std::move(sp));
  }
  return out;
}

/* ================= textures ================= */

struct Tex { SDL_Texture* t = nullptr; int w = 0, h = 0; };

struct TexCache {
  SDL_Renderer* ren{};
  std::map<std::string, Tex> cache;
  Tex* get(const std::string& path) {
    auto it = cache.find(path);
    if (it != cache.end()) return it->second.t ? &it->second : nullptr;
    Tex t;
    int n;
    unsigned char* px = stbi_load(path.c_str(), &t.w, &t.h, &n, 4);
    if (px) {
      SDL_Surface* s = SDL_CreateRGBSurfaceWithFormatFrom(px, t.w, t.h, 32, t.w * 4, SDL_PIXELFORMAT_RGBA32);
      t.t = SDL_CreateTextureFromSurface(ren, s);
      SDL_SetTextureBlendMode(t.t, SDL_BLENDMODE_BLEND);
      SDL_FreeSurface(s);
      stbi_image_free(px);
    }
    cache[path] = t;
    return cache[path].t ? &cache[path] : nullptr;
  }
};

struct SpinMeta { int frameW, frameH, xTiles, frames; };

/* ================= UI helpers ================= */

static SDL_Renderer* REN;
static void drawText(int x, int y, const std::string& s, SDL_Color c, int scale = 1) {
  SDL_SetRenderDrawColor(REN, c.r, c.g, c.b, c.a);
  int cx = x;
  for (unsigned char ch : s) {
    if (ch == '\n') { y += 9 * scale; cx = x; continue; }
    if (ch < 128)
      for (int row = 0; row < 8; row++)
        for (int bit = 0; bit < 8; bit++)
          if (font8x8_basic[ch][row] & (1 << bit)) {
            SDL_Rect px { cx + bit * scale, y + row * scale, scale, scale };
            SDL_RenderFillRect(REN, &px);
          }
    cx += 8 * scale;
  }
}
static int textW(const std::string& s, int scale = 1) { return (int)s.size() * 8 * scale; }
static void drawTextC(int cx, int y, const std::string& s, SDL_Color c, int scale = 1) {
  drawText(cx - textW(s, scale) / 2, y, s, c, scale);
}
static std::string wrap(const std::string& s, size_t cols) {
  std::string out, line, word;
  auto flush = [&] {
    if (line.size() + word.size() + 1 > cols && !line.empty()) { out += line + "\n"; line.clear(); }
    line += (line.empty() ? "" : " ") + word; word.clear();
  };
  for (char c : s) { if (c == ' ') flush(); else word += c; }
  flush(); out += line;
  return out;
}

static const SDL_Color WHITE{255,255,255,255}, GREY{140,155,185,255}, DGREY{100,112,140,255},
  GOLD{255,212,121,255}, GREEN{60,224,82,255}, DGREEN{29,122,46,255}, BLACK{0,0,0,255};

static SDL_Color govtColor(int govt) {
  static const SDL_Color hues[] = {
    {229,192,123,255},{97,175,239,255},{224,108,117,255},
    {152,195,121,255},{198,120,221,255},{86,182,194,255}};
  if (govt < 0) return {154,165,184,255};
  return hues[(govt - 128) % 6];
}

struct UIButton { SDL_Rect r; std::function<void()> fn; };
static std::vector<UIButton> gButtons;
static void button(int x, int y, int w, int h, const std::string& label, bool enabled,
                   std::function<void()> fn) {
  SDL_Rect r{x, y, w, h};
  SDL_SetRenderDrawColor(REN, 26, 35, 56, 255); SDL_RenderFillRect(REN, &r);
  SDL_SetRenderDrawColor(REN, 42, 53, 80, 255); SDL_RenderDrawRect(REN, &r);
  SDL_Color c = enabled ? SDL_Color{207,214,228,255} : SDL_Color{90,98,118,255};
  drawTextC(x + w / 2, y + (h - 8) / 2, label, c);
  if (enabled) gButtons.push_back({r, std::move(fn)});
}

/* ================= the game ================= */

struct Game {
  GameData data;
  std::string root;
  TexCache tex;
  std::map<int, SpinMeta> spins;

  /* world */
  int systId = 128;
  json syst;
  std::vector<Spob> spobs;
  std::list<Entity> ai;
  std::set<int> explored;
  int pendingSpawns = 0;

  /* player + economy */
  Entity player;
  int playerShipId = 128;
  long long credits = 10000;
  int cargo[6] = {0,0,0,0,0,0};
  std::map<int,int> outfits;
  double fuel = 400, fuelMax = 400;
  int holds = 20;

  /* combat state */
  std::vector<Shot> shots;
  struct Beam { Entity* owner; const json* rec; int life; bool turreted;
                Entity* target; double heading = 0, len = 0; };
  std::vector<Beam> beams;
  struct Expl { double x, y; int spin, f, frames, tick; };
  std::vector<Expl> explosions;
  bool gameOver = false, fireHeld = false;

  /* ui state */
  const Spob* landedAt = nullptr;
  const Spob* navTarget = nullptr;
  Entity* shipTarget = nullptr;
  bool mapOpen = false;
  int jumpDest = -1;
  struct { bool active = false; int destId = -1; bool streak = false; int t = 0; } jump;
  std::string service; // "", "exchange", "outfitter", "shipyard"
  int selOutfit = -1, selShip = -1;
  std::string message; int msgTtl = 0;

  void showMsg(const std::string& m) { message = m; msgTtl = FPS * 4; }

  /* ---- stats & econ (mirror browser shell) ---- */
  double num(const json& j, const char* k) const { return j[k].get<double>(); }
  struct Eff { double speed, accel, turn; int holds, fuelMax, freeMass; double shield, armor; };
  Eff effective() const {
    auto& r = data.ship(playerShipId);
    Eff e{ num(r,"Speed"), num(r,"Accel"), num(r,"Maneuver"),
           (int)num(r,"Holds"), (int)num(r,"Fuel"), (int)num(r,"FreeMass"),
           num(r,"Shield"), num(r,"Armor") };
    for (auto& [id, n] : outfits) {
      if (!n) continue;
      auto& o = data.outf(id);
      std::string mt = o["$sem"]["modType"].is_string() ? o["$sem"]["modType"].get<std::string>() : "";
      double v = num(o, "ModVal") * n;
      e.freeMass -= (int)num(o, "Mass") * n;
      if (mt == "cargoSpace") e.holds += (int)v;
      else if (mt == "fuelCapacity") e.fuelMax += (int)v;
      else if (mt == "shieldCapacity") e.shield += v;
      else if (mt == "armor") e.armor += v;
      else if (mt == "accelBoost") e.accel += v;
      else if (mt == "speedBoost") e.speed += v;
      else if (mt == "turnBoost") e.turn += v;
    }
    return e;
  }
  /* ---- combat helpers (mirror the browser shell) ---- */
  static int poolKeyOf(const json& rec) {
    int a = (int)rec["AmmoType"].get<double>();
    return (a >= 0 && a <= 63) ? 128 + a : -1;
  }
  void armShip(Entity& e, const json& rec) {
    e.shieldMax = e.shields = num(rec, "Shield");
    e.armorMax = e.armor = num(rec, "Armor");
    e.shieldRe = (int)num(rec, "ShieldRe");
    e.mass = std::max(num(rec, "Mass"), 1.0);
    e.deathDelay = (int)num(rec, "DeathDelay");
    e.disableFrac = ((int)rec.value("Flags", 0.0) & 0x0010) ? 0.10 : 1.0 / 3.0; // classic shïp has no Flags field
    e.deathT = -1; e.disabled = e.hostile = e.fleeing = false;
    e.shieldT = 0;
    e.weapons.clear(); e.pools.clear(); e.poolCap.clear();
    for (int i = 1; i <= 4; i++) {
      int t = (int)num(rec, ("WeapType" + std::to_string(i)).c_str());
      if (t >= 128 && !data.rec("weap", t).is_null()) {
        e.weapons.push_back({ t, &data.rec("weap", t),
          std::max((int)num(rec, ("WeapCount" + std::to_string(i)).c_str()), 1), 0 });
        int pk = poolKeyOf(data.rec("weap", t));
        if (pk >= 0) {
          int load = std::max((int)num(rec, ("AmmoLoad" + std::to_string(i)).c_str()), 0);
          e.pools[pk] += load;
          e.poolCap[pk] += load;
        }
      }
    }
  }
  void rebuildPlayerWeapons() {
    Eff s = effective();
    double sf = player.shieldMax > 0 ? player.shields / player.shieldMax : 1;
    double af = player.armorMax > 0 ? player.armor / player.armorMax : 1;
    json merged = data.ship(playerShipId);
    merged["Shield"] = s.shield; merged["Armor"] = s.armor;
    armShip(player, merged);
    player.shields = player.shieldMax * sf;
    player.armor = player.armorMax * af;
    for (auto& [oid, n] : outfits) {
      if (!n) continue;
      auto& o = data.outf(oid);
      std::string mt = o["$sem"]["modType"].is_string() ? o["$sem"]["modType"].get<std::string>() : "";
      int mv = (int)num(o, "ModVal");
      if (mt == "weapon" && !data.rec("weap", mv).is_null()) {
        bool found = false;
        for (auto& w : player.weapons) if (w.id == mv) { w.n += n; found = true; }
        if (!found) player.weapons.push_back({ mv, &data.rec("weap", mv), n, 0 });
      } else if (mt == "ammunition" && !data.rec("weap", mv).is_null()) {
        int pk = poolKeyOf(data.rec("weap", mv));
        int key = pk >= 0 ? pk : mv;
        player.pools[key] += n;
        int mx = (int)num(o, "Max");
        player.poolCap[key] += mx > 0 ? mx : n;
      }
    }
    bool selOk = false;
    for (auto& w : player.weapons)
      if (w.id == player.selSecondary && ((int)num(*w.rec, "MiscFlags") & 2)) selOk = true;
    if (!selOk) {
      player.selSecondary = -1;
      for (auto& w : player.weapons)
        if ((int)num(*w.rec, "MiscFlags") & 2) { player.selSecondary = w.id; break; }
    }
  }
  double leadAim(const Entity& e, const Entity& t, double shotSpeed) {
    double dist = std::hypot(t.x - e.x, t.y - e.y);
    double dt = shotSpeed > 0 ? dist / shotSpeed : 0;
    return evBearing(t.x + t.vx * dt - e.x, t.y + t.vy * dt - e.y);
  }
  static double clampArc(double aim, double base, double arc) {
    double d = norm360(aim - base);
    if (d > 180) d -= 360;
    return norm360(base + std::clamp(d, -arc, arc));
  }
  void spawnExplosion(double x, double y, int type) {
    int spin = 400 + std::clamp(type, 0, 2);
    auto it = spins.find(spin);
    if (it != spins.end()) explosions.push_back({ x, y, spin, 0, it->second.frames, 0 });
  }
  void grudge(Entity& victim, Entity* attacker) {
    if (attacker != &player || victim.aiType == 0) return;
    auto react = [](Entity& s) {
      if (s.aiType >= 3 || s.aiType == 2) s.hostile = true; else s.fleeing = true;
    };
    react(victim);
    for (auto& s : ai) if (s.govt == victim.govt && s.govt >= 128) react(s);
  }
  double shipHalf(const Entity& e) {
    auto it = spins.find(128 + (e.shipId - 128));
    return it != spins.end() ? std::max(it->second.frameW, it->second.frameH) / 2.0 : 16;
  }
  void hitShip(Entity& v, const Shot& s) {
    Hit r = evApplyDamage(v, s.massDmg, s.energyDmg);
    double kick = s.impact / (10 * v.mass);
    v.vx += std::sin(d2r(s.heading)) * kick;
    v.vy -= std::cos(d2r(s.heading)) * kick;
    if (s.explodType >= 0) spawnExplosion(s.x, s.y, s.explodType);
    if (r == Hit::DESTROYED && v.deathT < 0) v.deathT = std::max(v.deathDelay, 1);
    else if (r == Hit::DISABLED) v.disabled = true;
    grudge(v, s.owner);
  }
  double maxWeaponRange(const Entity& e) {
    double r = 0;
    for (auto& w : e.weapons) {
      int g = (int)num(*w.rec, "Guidance");
      if (g == 99) continue;
      r = std::max(r, (g == 0 || g == 3) ? num(*w.rec, "Speed")
                                         : num(*w.rec, "Speed") / 100.0 * num(*w.rec, "Count"));
    }
    return r;
  }
  void fire(Entity& e, Entity* target, bool primary) {
    for (auto& w : e.weapons) {
      bool sec = ((int)num(*w.rec, "MiscFlags") & 2) != 0;
      if (primary ? sec : w.id != e.selSecondary) continue;
      if (w.cool > 0) continue;
      int g = (int)num(*w.rec, "Guidance");
      if (g == 99) continue;
      int pk = poolKeyOf(*w.rec);
      if (g == 0 || g == 3) {
        if (pk >= 0 && e.pools[pk] < 1) continue;
        if (pk >= 0) e.pools[pk]--;
        beams.push_back({ &e, w.rec, (int)num(*w.rec, "Count"), g == 3, target });
        w.cool = (int)(num(*w.rec, "Reload") + num(*w.rec, "Count"));
        continue;
      }
      bool fired = false;
      for (int i = 0; i < w.n; i++) {
        if (pk >= 0) { if (e.pools[pk] < 1) break; e.pools[pk]--; }
        double aim = e.heading;
        double sp = num(*w.rec, "Speed") / 100.0;
        if ((g == 1 || g == 2 || g == 4) && target) aim = leadAim(e, *target, sp);
        if (g == 7 || g == 8) {
          double base = g == 7 ? e.heading : norm360(e.heading + 180);
          aim = target ? clampArc(leadAim(e, *target, sp), base, 45) : base;
        }
        aim = norm360(aim + (frand() * 2 - 1) * num(*w.rec, "Inaccuracy"));
        Shot s = evMakeShot(*w.rec, e, aim);
        s.owner = &e;
        s.homing = (g == 1 || g == 2) ? target : nullptr;
        shots.push_back(s);
        fired = true;
      }
      if (fired) w.cool = (int)num(*w.rec, "Reload");
    }
  }
  void forgetEntity(Entity* e) {
    if (shipTarget == e) shipTarget = nullptr;
    for (auto& s : shots) { if (s.owner == e) s.owner = nullptr; if (s.homing == e) s.homing = nullptr; }
    for (auto& b : beams) { if (b.owner == e) b.life = 0; if (b.target == e) b.target = nullptr; }
  }

  void applyStats() {
    Eff e = effective();
    player.maxSpeed = e.speed / kMaxSpeedDiv;
    player.accel = e.accel / kAccelDiv;
    player.turn = e.turn;
    holds = e.holds; fuelMax = e.fuelMax;
    fuel = std::min(fuel, fuelMax);
    rebuildPlayerWeapons();
  }
  int cargoUsed() const { int n = 0; for (int c : cargo) n += c; return n; }
  int priceAt(const Spob& p, int i) const {
    if (p.prices[i].empty()) return -1;
    double base = std::stod(data.db["strings"]["4004"]["list"][i].get<std::string>());
    double m = p.prices[i] == "low" ? PRICE_MULT_LOW : p.prices[i] == "high" ? PRICE_MULT_HIGH : PRICE_MULT_MED;
    return (int)std::lround(base * m);
  }
  bool techOK(int t, const Spob& p) const {
    return t <= p.techLevel || t == p.st1 || t == p.st2 || t == p.st3;
  }
  long long tradeIn() const {
    long long v = (long long)num(data.ship(playerShipId), "Cost");
    for (auto& [id, n] : outfits) v += (long long)num(data.outf(id), "Cost") * n;
    return llround(0.25 * v);
  }

  /* ---- world ---- */
  void loadSystem(int id) {
    systId = id;
    syst = data.db["types"]["syst"][std::to_string(id)];
    explored.insert(id);
    spobs = spobsOf(data, id);
    ai.clear();
    shots.clear(); beams.clear(); explosions.clear();
    shipTarget = nullptr; navTarget = nullptr;
    int want = std::clamp(syst["AvgShips"].get<int>(), 2, 8);
    for (int i = 0; i < want; i++) spawnAI(false);
    for (auto& [sid, s] : data.man["spins"].items())
      spins[std::stoi(sid)] = { s["frameW"], s["frameH"], s["xTiles"], s["frames"] };
  }
  int weightedPick(const std::vector<std::pair<int,int>>& e) {
    if (e.empty()) return -1;
    int total = 0; for (auto& [v, w] : e) total += w;
    double r = frand() * total;
    for (auto& [v, w] : e) { if ((r -= w) <= 0) return v; }
    return e[0].first;
  }
  void spawnAI(bool atEdge) {
    std::vector<std::pair<int,int>> ds;
    for (int i = 1; i <= 4; i++) {
      int d = syst["DudeTypes" + std::to_string(i)], w = syst["Prob" + std::to_string(i)];
      if (d >= 128 && w > 0 && data.has("dude", d)) ds.push_back({d, w});
    }
    int dudeId = weightedPick(ds);
    if (dudeId < 0) return;
    auto& dude = data.rec("dude", dudeId);
    std::vector<std::pair<int,int>> ss;
    for (int i = 1; i <= 4; i++) {
      int s = dude["ShipTypes" + std::to_string(i)], w = dude["Prob" + std::to_string(i)];
      if (s >= 128 && w > 0 && !data.ship(s).is_null()) ss.push_back({s, w});
    }
    int shipId = weightedPick(ss);
    if (shipId < 0) return;
    double a = frand() * 2 * M_PI, r = atEdge ? 2400 : 400 + frand() * 1200;
    Entity e;
    auto& rec = data.ship(shipId);
    e.shipId = shipId;
    e.x = std::cos(a) * r; e.y = std::sin(a) * r; e.heading = frand() * 360;
    e.maxSpeed = num(rec,"Speed") / kMaxSpeedDiv;
    e.accel = num(rec,"Accel") / kAccelDiv;
    e.turn = num(rec,"Maneuver");
    e.dudeId = dudeId; e.govt = dude["Govt"];
    e.aiType = (int)dude["AIType"].get<double>();
    e.target = spobs.empty() ? nullptr : &spobs[(size_t)(frand() * spobs.size())];
    armShip(e, rec);
    if (e.govt >= 128 && e.aiType >= 3 && data.has("govt", e.govt)) {
      auto& gs = data.rec("govt", e.govt);
      if (gs.contains("$sem") && gs["$sem"]["flags"].is_array())
        for (auto& f : gs["$sem"]["flags"]) {
          std::string fn = f.get<std::string>();
          if (fn == "alwaysAttacksPlayer" || fn == "xenophobic") e.hostile = true;
        }
    }
    ai.push_back(e);
  }

  double distTo(double x, double y) const { return std::hypot(x - player.x, y - player.y); }

  /* ---- targeting / landing / jump (mirror browser shell) ---- */
  const Spob* nearestLandable() {
    const Spob* best = nullptr; double bd = 1e18;
    for (auto& p : spobs) {
      if (!p.canLand) continue;
      double d = distTo(p.x, p.y);
      if (d < bd) { bd = d; best = &p; }
    }
    return best;
  }
  void cyclePlanet() {
    if (spobs.empty()) { showMsg("No stellar objects in this system."); return; }
    std::vector<const Spob*> sorted;
    for (auto& p : spobs) sorted.push_back(&p);
    std::sort(sorted.begin(), sorted.end(), [&](auto a, auto b) {
      return distTo(a->x, a->y) < distTo(b->x, b->y); });
    auto it = std::find(sorted.begin(), sorted.end(), navTarget);
    size_t i = it == sorted.end() ? SIZE_MAX : it - sorted.begin();
    navTarget = (i + 1 < sorted.size()) ? sorted[i + 1] : nullptr;
    if (!navTarget) showMsg("Navigation target cleared.");
  }
  void cycleShip() {
    if (ai.empty()) { showMsg("No ships on scope."); shipTarget = nullptr; return; }
    std::vector<Entity*> sorted;
    for (auto& s : ai) sorted.push_back(&s);
    std::sort(sorted.begin(), sorted.end(), [&](auto a, auto b) {
      return distTo(a->x, a->y) < distTo(b->x, b->y); });
    auto it = std::find(sorted.begin(), sorted.end(), shipTarget);
    size_t i = it == sorted.end() ? SIZE_MAX : it - sorted.begin();
    shipTarget = (i + 1 < sorted.size()) ? sorted[i + 1] : nullptr;
    if (!shipTarget) showMsg("Target cleared.");
  }
  void hail() {
    if (shipTarget) {
      std::string line = data.randStr(7000 + (shipTarget->govt - 128));
      if (line.empty()) line = data.randStr(6999);
      std::string name = asciify(data.ship(shipTarget->shipId)["name"].get<std::string>());
      showMsg(line.empty() ? name + " does not respond." : name + ": \"" + line + "\"");
    } else if (navTarget) {
      if (navTarget->uninhabited || !navTarget->canLand) showMsg(navTarget->name + " does not respond.");
      else {
        std::string line = data.randStr(3002);
        showMsg(navTarget->name + ": \"" + (line.empty() ? "Communications channel open." : line) + "\"");
      }
    } else showMsg("No target to hail. (Tab: ships, N: planets)");
  }
  void tryLand() {
    if (landedAt || jump.active) return;
    const Spob* p = (navTarget && navTarget->canLand) ? navTarget : nearestLandable();
    if (!p) { showMsg("There is nowhere to land in this system."); return; }
    if (navTarget != p) { navTarget = p; showMsg("Targeting " + p->name + "."); return; }
    if (distTo(p->x, p->y) >= LAND_DIST) { showMsg("Landing on " + p->name + ": too far away."); return; }
    if (std::hypot(player.vx, player.vy) > LAND_SPEED) { showMsg("You are moving too fast to land."); return; }
    landedAt = p;
    player.vx = player.vy = 0;
    fuel = fuelMax;
    player.shields = player.shieldMax;
    player.armor = player.armorMax;
    player.disabled = false;
    rebuildPlayerWeapons(); // rearm (ammo refills on landing — simplification)
  }
  void takeOff() {
    if (!landedAt) return;
    service.clear();
    evPlaceAtTakeoff(player, landedAt->x, landedAt->y);
    navTarget = nullptr;
    landedAt = nullptr;
  }
  std::vector<int> linked() {
    std::vector<int> out;
    for (int i = 1; i <= 16; i++) {
      int c = syst["Con" + std::to_string(i)];
      if (c >= 128 && data.has("syst", c)) out.push_back(c);
    }
    return out;
  }
  double mapBearingTo(int destId) {
    auto& a = data.rec("syst", systId);
    auto& b = data.rec("syst", destId);
    return evBearing(num(b,"xPos") - num(a,"xPos"), num(b,"yPos") - num(a,"yPos"));
  }
  void beginJump() {
    if (jump.active || landedAt || jumpDest < 0) return;
    auto l = linked();
    if (std::find(l.begin(), l.end(), jumpDest) == l.end()) return;
    if (fuel < JUMP_FUEL) { showMsg("Not enough fuel to jump."); return; }
    jump = { true, jumpDest, false, 0 };
  }
  void completeJump() {
    int from = systId;
    loadSystem(jump.destId);
    evPlaceAtArrival(player, norm360(mapBearingTo(from) + 180));
    fuel -= JUMP_FUEL;
    jump = {};
    jumpDest = -1;
  }

  /* ---- shop actions ---- */
  void trade(int i, int qty) {
    if (!landedAt) return;
    int price = priceAt(*landedAt, i);
    if (price < 0) return;
    if (qty > 0) qty = std::min({qty, holds - cargoUsed(), (int)(credits / price)});
    else qty = std::max(qty, -cargo[i]);
    cargo[i] += qty;
    credits -= (long long)qty * price;
  }
  void buyOutfit(int id, int qty) {
    auto& o = data.outf(id);
    if (o.is_null()) return;
    Eff e = effective();
    int cost = (int)num(o,"Cost"), mass = (int)num(o,"Mass"), mx = (int)num(o,"Max");
    int own = outfits.count(id) ? outfits[id] : 0;
    if (qty > 0) {
      if (mx > 0 && own + qty > mx) qty = mx - own;
      if (mass > 0) qty = std::min(qty, e.freeMass / mass);
      if (cost > 0) qty = std::min(qty, (int)(credits / cost));
      if (qty <= 0) return;
    } else { qty = std::max(qty, -own); if (!qty) return; }
    outfits[id] += qty;
    if (!outfits[id]) outfits.erase(id);
    credits -= (long long)qty * cost;
    applyStats();
    while (cargoUsed() > holds)
      for (int& c : cargo) if (c > 0) { c--; break; }
  }
  void buyShip(int id) {
    auto& r = data.ship(id);
    if (r.is_null() || id == playerShipId) return;
    long long refund = tradeIn();
    long long price = (long long)num(r,"Cost") - refund;
    if (credits < price) return;
    if (cargoUsed() > (int)num(r,"Holds")) { showMsg("Your cargo would not fit aboard."); return; }
    credits -= price;
    playerShipId = id;
    player.shipId = id;
    outfits.clear();
    applyStats();
    fuel = fuelMax;
    showMsg(asciify(r["name"].get<std::string>()) + " purchased. Old hull and outfits traded in.");
  }

  /* ---- per-frame logic ---- */
  void step(const Uint8* keys, bool forceThrust) {
    if (msgTtl > 0) msgTtl--;
    if (!landedAt) {
      if (jump.active && !jump.streak) {
        if (evStepJumpEngage(player, mapBearingTo(jump.destId))) { jump.streak = true; jump.t = 0; }
      } else if (jump.active) {
        evThrust(player); evIntegrate(player);
        if (++jump.t >= JUMP_STREAK_FRAMES) completeJump();
      } else if (player.disabled) {
        evIntegrate(player);
      } else if (player.deathT >= 0) {
        evIntegrate(player);
        if (--player.deathT <= 0) {
          spawnExplosion(player.x, player.y, player.deathDelay >= 60 ? 2 : 1);
          gameOver = true;
        }
      } else {
        Controls c;
        c.left  = keys[SDL_SCANCODE_LEFT]  || keys[SDL_SCANCODE_A];
        c.right = keys[SDL_SCANCODE_RIGHT] || keys[SDL_SCANCODE_D];
        c.retro = keys[SDL_SCANCODE_DOWN]  || keys[SDL_SCANCODE_S];
        c.thrust = (keys[SDL_SCANCODE_UP]  || keys[SDL_SCANCODE_W]) || forceThrust;
        evStepPlayer(player, c);
        evStepShields(player, player.shieldMax, player.shieldRe);
        for (auto& w : player.weapons) if (w.cool > 0) w.cool--;
        if (keys[SDL_SCANCODE_SPACE] || fireHeld) fire(player, shipTarget, true);
        if (keys[SDL_SCANCODE_X] && player.selSecondary >= 0) fire(player, shipTarget, false);
      }
    }
    if (pendingSpawns > 0 && frand() < 0.01) { pendingSpawns--; spawnAI(frand() < 0.5); }

    for (auto it = ai.begin(); it != ai.end();) {
      Entity& s = *it;
      if (s.deathT >= 0) {
        evIntegrate(s);
        if (--s.deathT <= 0) {
          spawnExplosion(s.x, s.y, s.deathDelay >= 60 ? 2 : 1);
          forgetEntity(&s);
          it = ai.erase(it);
          pendingSpawns++;
          continue;
        }
        ++it; continue;
      }
      if (s.disabled) { evIntegrate(s); ++it; continue; }
      evStepShields(s, s.shieldMax, s.shieldRe);
      for (auto& w : s.weapons) if (w.cool > 0) w.cool--;
      if (s.hostile && player.deathT < 0 && !gameOver && !landedAt) {
        bool aligned; double dist;
        evStepWarship(s, player.x, player.y, aligned, dist);
        if (aligned && dist < maxWeaponRange(s)) fire(s, &player, true);
      } else if (s.fleeing) {
        evStepFlee(s, player.x, player.y);
      } else if (!evStepTrader(s, s.target != nullptr,
                   s.target ? s.target->x : 0, s.target ? s.target->y : 0)) {
        forgetEntity(&s);
        it = ai.erase(it);
        pendingSpawns++;
        continue;
      }
      ++it;
    }

    /* shots */
    bool playerVulnerable = player.deathT < 0 && !landedAt && !gameOver;
    for (size_t i = 0; i < shots.size();) {
      Shot& sh = shots[i];
      bool alive = evStepShot(sh, sh.homing);
      bool hit = false;
      auto tryHit = [&](Entity& v) {
        if (hit || &v == sh.owner || v.deathT >= 0) return;
        if (std::hypot(v.x - sh.x, v.y - sh.y) < std::max(sh.proxRadius, shipHalf(v))) {
          hitShip(v, sh);
          hit = true;
        }
      };
      if (playerVulnerable) tryHit(player);
      for (auto& v : ai) tryHit(v);
      if (hit || !alive) shots.erase(shots.begin() + i);
      else i++;
    }

    /* beams */
    for (size_t i = 0; i < beams.size();) {
      Beam& b = beams[i];
      if (!b.owner || b.owner->deathT >= 0 || --b.life <= 0) { beams.erase(beams.begin() + i); continue; }
      b.heading = (b.turreted && b.target)
        ? evBearing(b.target->x - b.owner->x, b.target->y - b.owner->y)
        : b.owner->heading;
      double dx = std::sin(d2r(b.heading)), dy = -std::cos(d2r(b.heading));
      double range = num(*b.rec, "Speed");
      double bestT = 1e18; Entity* bestV = nullptr;
      auto trace = [&](Entity& v) {
        if (&v == b.owner || v.deathT >= 0) return;
        double t = (v.x - b.owner->x) * dx + (v.y - b.owner->y) * dy;
        if (t < 0 || t > range) return;
        double px = b.owner->x + dx * t, py = b.owner->y + dy * t;
        if (std::hypot(v.x - px, v.y - py) < 8 + shipHalf(v) / 2 && t < bestT) { bestT = t; bestV = &v; }
      };
      if (playerVulnerable) trace(player);
      for (auto& v : ai) trace(v);
      b.len = bestV ? bestT : range;
      if (bestV) {
        Hit r = evApplyDamage(*bestV, num(*b.rec, "MassDmg"), num(*b.rec, "EnergyDmg"));
        if (r == Hit::DESTROYED && bestV->deathT < 0) bestV->deathT = std::max(bestV->deathDelay, 1);
        else if (r == Hit::DISABLED) bestV->disabled = true;
        grudge(*bestV, b.owner);
      }
      i++;
    }

    /* explosions */
    for (size_t i = 0; i < explosions.size();) {
      Expl& ex = explosions[i];
      if (++ex.tick % 2 == 0 && ++ex.f >= ex.frames) explosions.erase(explosions.begin() + i);
      else i++;
    }
  }
};

/* ================= rendering ================= */

static int WIN_W = 1024, WIN_H = 700;

struct Renderer {
  Game& g;
  TexCache& tex;
  std::string root;

  std::string spinPath(int id) { return root + "/evassets/sprites/spin_" + std::to_string(id) + ".png"; }
  std::string gfxPath(const std::string& f) { return root + "/evassets/graphics/" + f; }
  std::string titlePath(const std::string& f) { return root + "/evassets/titles/" + f; }

  int shipSpin(int id) { return 128 + (id - 128); }
  int spobSpin(const Spob& p) { return 300 + p.type; }

  void drawSpin(int spinId, double x, double y, double heading) {
    auto it = g.spins.find(spinId);
    Tex* t = tex.get(spinPath(spinId));
    if (!t || it == g.spins.end()) return;
    const SpinMeta& m = it->second;
    int fi = (int)std::lround(heading / (360.0 / m.frames)) % m.frames;
    if (fi < 0) fi += m.frames;
    SDL_Rect src{ (fi % m.xTiles) * m.frameW, (fi / m.xTiles) * m.frameH, m.frameW, m.frameH };
    SDL_Rect dst{ (int)std::lround(x - m.frameW / 2.0), (int)std::lround(y - m.frameH / 2.0), m.frameW, m.frameH };
    SDL_RenderCopy(REN, t->t, &src, &dst);
  }
  int spinHalf(int spinId, int fb) {
    auto it = g.spins.find(spinId);
    return (it != g.spins.end() ? std::max(it->second.frameW, it->second.frameH) : fb) / 2 + 6;
  }

  void drawFlame(const Entity& s, double x, double y, int frameH) {
    if (!s.thrusting) return;
    double a = d2r(s.heading), off = frameH / 2.0 + 3, len = 7 + frand() * 4;
    double bx = x - std::sin(a) * off, by = y + std::cos(a) * off;
    auto pt = [&](double lx, double ly) {
      return SDL_FPoint{ (float)(bx + lx * std::cos(a) - ly * std::sin(a)),
                         (float)(by + lx * std::sin(a) + ly * std::cos(a)) };
    };
    SDL_Color c{255,170,60,217};
    SDL_Vertex v[3] = { {pt(-3,0),c,{}}, {pt(3,0),c,{}}, {pt(0,len),c,{}} };
    SDL_RenderGeometry(REN, nullptr, v, 3, nullptr, 0);
  }

  void drawBrackets(double x, double y, int half, SDL_Color c) {
    int arm = std::max(6, (int)(half * 0.45));
    SDL_SetRenderDrawColor(REN, c.r, c.g, c.b, c.a);
    for (int sx : {-1, 1}) for (int sy : {-1, 1}) {
      SDL_RenderDrawLine(REN, (int)x + sx*half, (int)y + sy*(half-arm), (int)x + sx*half, (int)y + sy*half);
      SDL_RenderDrawLine(REN, (int)x + sx*(half-arm), (int)y + sy*half, (int)x + sx*half, (int)y + sy*half);
    }
  }

  void drawStars(int w, int h, int streak) {
    struct L { int id; double par; Uint8 a; };
    for (L l : { L{1,0.3,128}, L{2,0.6,230} }) {
      double ox = g.player.x * l.par, oy = g.player.y * l.par;
      SDL_SetRenderDrawColor(REN, 255, 255, 255, l.a);
      int c0x = (int)std::floor((ox - w/2.0)/512), c1x = (int)std::floor((ox + w/2.0)/512);
      int c0y = (int)std::floor((oy - h/2.0)/512), c1y = (int)std::floor((oy + h/2.0)/512);
      for (int cx = c0x; cx <= c1x; cx++) for (int cy = c0y; cy <= c1y; cy++) {
        int32_t hh = (cx * 73856093) ^ (cy * 19349663) ^ (l.id * 83492791);
        for (int i = 0; i < 5; i++) {
          hh = (int32_t)((hh * 1103515245LL + 12345) & 0x7fffffff);
          int sx = hh % 512; hh = (int32_t)((hh * 1103515245LL + 12345) & 0x7fffffff);
          int sy = hh % 512; hh = (int32_t)((hh * 1103515245LL + 12345) & 0x7fffffff);
          int r = (hh % 3) == 0 ? 2 : 1;
          double x = cx*512 + sx - ox + w/2.0, y = cy*512 + sy - oy + h/2.0;
          if (x < -20 || x > w+20 || y < -20 || y > h+20) continue;
          if (streak > 0) {
            double a = d2r(g.player.heading), len = streak * 6 * l.par;
            SDL_RenderDrawLine(REN, (int)x, (int)y,
              (int)(x - std::sin(a)*len), (int)(y + std::cos(a)*len));
          } else { SDL_Rect px{(int)x,(int)y,r,r}; SDL_RenderFillRect(REN, &px); }
        }
      }
    }
  }

  /* classic sidebar (PICT 128 Game Panel; geometry per ENGINE_SPEC) */
  void drawPanel(int w, int h) {
    const int pw = 144, ph = 480;
    int px = w - pw, py = std::max(0, (h - ph) / 2);
    Tex* panel = tex.get(titlePath("PICT_128.png"));
    if (panel) { SDL_Rect d{px,py,pw,ph}; SDL_RenderCopy(REN, panel->t, nullptr, &d); }
    else { SDL_SetRenderDrawColor(REN,4,16,4,255); SDL_Rect d{px,py,pw,ph}; SDL_RenderFillRect(REN,&d); }

    /* radar */
    SDL_Rect rr{px+5, py+4, 134, 133};
    SDL_RenderSetClipRect(REN, &rr);
    double rcx = rr.x + rr.w/2.0, rcy = rr.y + rr.h/2.0, sc = (rr.w/2.0)/2600;
    auto blip = [&](double wx, double wy, SDL_Color c, int sz) -> bool {
      double x = rcx + (wx - g.player.x)*sc, y = rcy + (wy - g.player.y)*sc;
      if (x < rr.x || x > rr.x+rr.w || y < rr.y || y > rr.y+rr.h) return false;
      SDL_SetRenderDrawColor(REN,c.r,c.g,c.b,255);
      SDL_Rect d{(int)x-sz/2,(int)y-sz/2,sz,sz}; SDL_RenderFillRect(REN,&d);
      return true;
    };
    for (auto& p : g.spobs) blip(p.x, p.y, {127,208,255,255}, 3);
    for (auto& s : g.ai) {
      blip(s.x, s.y, govtColor(s.govt), 2);
      if (&s == g.shipTarget) {
        double x = rcx + (s.x - g.player.x)*sc, y = rcy + (s.y - g.player.y)*sc;
        SDL_SetRenderDrawColor(REN, 255,212,121,255);
        SDL_Rect d{(int)x-3,(int)y-3,6,6}; SDL_RenderDrawRect(REN,&d);
      }
    }
    blip(g.player.x, g.player.y, WHITE, 3);
    SDL_RenderSetClipRect(REN, nullptr);

    /* bars */
    SDL_SetRenderDrawColor(REN, GREEN.r, GREEN.g, GREEN.b, 255);
    SDL_Rect sb{px+60, py+154,
      (int)std::lround(74 * std::max(0.0, g.player.shieldMax > 0 ? g.player.shields / g.player.shieldMax : 0)), 6};
    SDL_RenderFillRect(REN, &sb);
    SDL_Rect fb{px+60, py+170, (int)std::lround(74 * (g.fuel / g.fuelMax)), 6}; SDL_RenderFillRect(REN, &fb);

    /* secondary weapon display (classic behavior — not a message mirror) */
    if (g.player.selSecondary >= 0) {
      auto& wr = g.data.rec("weap", g.player.selSecondary);
      drawText(px+9, py+198, wr["name"].is_string() ? asciify(wr["name"].get<std::string>())
                                                    : "weapon " + std::to_string(g.player.selSecondary), GREEN);
      int pk = Game::poolKeyOf(wr);
      if (pk >= 0) {
        int cur = g.player.pools.count(pk) ? g.player.pools.at(pk) : 0;
        int cap = g.player.poolCap.count(pk) ? g.player.poolCap.at(pk) : 0;
        drawText(px+9, py+210, "Ammo: " + std::to_string(cur) +
          (cap > 0 ? "/" + std::to_string(cap) : ""),
          cur > 0 ? GREEN : SDL_Color{224,108,117,255});
      } else drawText(px+9, py+210, "Ready", DGREEN);
    } else drawText(px+9, py+198, "No secondary", DGREEN);

    /* strip: dest / system */
    std::string strip = g.jump.active
      ? "Hyper: " + asciify(g.data.rec("syst", g.jump.destId)["name"].get<std::string>())
      : g.jumpDest >= 0
        ? "Dest: " + asciify(g.data.rec("syst", g.jumpDest)["name"].get<std::string>())
        : asciify(g.syst["name"].get<std::string>());
    drawText(px+9, py+241, strip, GREEN);

    /* target display */
    int tcx = px + 72, ty = py + 262;
    if (g.shipTarget) {
      drawSpin(shipSpin(g.shipTarget->shipId), tcx, ty + 40, g.shipTarget->heading);
      std::string nm = asciify(g.data.ship(g.shipTarget->shipId)["name"].get<std::string>());
      std::string gv = g.shipTarget->govt >= 128 && g.data.has("govt", g.shipTarget->govt)
        ? asciify(g.data.rec("govt", g.shipTarget->govt)["name"].get<std::string>())
        : "Independent";
      drawTextC(tcx, ty + 80, nm, WHITE);
      drawTextC(tcx, ty + 92, gv, govtColor(g.shipTarget->govt));
      int shp = (int)std::lround(100 * std::max(0.0, g.shipTarget->shields) /
        std::max(g.shipTarget->shieldMax, 1.0));
      if (g.shipTarget->disabled) drawTextC(tcx, ty + 104, "DISABLED", {224,108,117,255});
      else drawTextC(tcx, ty + 104, "Shields " + std::to_string(shp) + "%", GREEN);
    } else if (g.navTarget) {
      drawSpin(spobSpin(*g.navTarget), tcx, ty + 44, 0);
      drawTextC(tcx, ty + 92, g.navTarget->name, WHITE);
      char b[32]; std::snprintf(b, sizeof b, "%.0fpx", g.distTo(g.navTarget->x, g.navTarget->y));
      drawTextC(tcx, ty + 104, b, GREEN);
    } else drawTextC(tcx, ty + 56, "No target", DGREEN);

    /* cargo box */
    int cx = px + 9, cy = py + 396;
    drawText(cx, cy, "Credits: " + commas(g.credits), GREEN);
    drawText(cx, cy + 12, "Jumps left: " + std::to_string((int)(g.fuel / JUMP_FUEL)), GREEN);
    int line = 0;
    bool any = false;
    for (int i = 0; i < 6 && line < 4; i++)
      if (g.cargo[i] > 0) {
        drawText(cx, cy + 28 + line*11,
          std::to_string(g.cargo[i]) + "t " + g.data.str(4000, i), GREEN);
        line++; any = true;
      }
    if (!any) drawText(cx, cy + 28, "Cargo: " + std::to_string(g.holds) + "t free", DGREEN);
  }

  void drawMap(int w, int h) {
    int mw = std::min((int)(w * 0.72), 900), mh = std::min((int)(h * 0.72), 620);
    int mx = (w - mw) / 2, my = (h - mh) / 2;
    SDL_SetRenderDrawColor(REN, 4, 6, 12, 238);
    SDL_Rect r{mx,my,mw,mh}; SDL_RenderFillRect(REN, &r);
    SDL_SetRenderDrawColor(REN, 42,53,80,255); SDL_RenderDrawRect(REN, &r);

    auto& systs = g.data.db["types"]["syst"];
    double x0=1e18,x1=-1e18,y0=1e18,y1=-1e18;
    for (auto& [id,s] : systs.items()) {
      x0=std::min(x0,g.num(s,"xPos")); x1=std::max(x1,g.num(s,"xPos"));
      y0=std::min(y0,g.num(s,"yPos")); y1=std::max(y1,g.num(s,"yPos"));
    }
    double sc = std::min((mw-60)/(x1-x0), (mh-60)/(y1-y0));
    auto PX = [&](const json& s){ return mx+30+(g.num(s,"xPos")-x0)*sc; };
    auto PY = [&](const json& s){ return my+30+(g.num(s,"yPos")-y0)*sc; };

    for (auto& [id,s] : systs.items())
      for (int i = 1; i <= 16; i++) {
        int c = s["Con"+std::to_string(i)];
        if (c >= 128 && systs.contains(std::to_string(c)) && std::stoi(id) < c &&
            (g.explored.count(std::stoi(id)) || g.explored.count(c))) {
          SDL_SetRenderDrawColor(REN, 90,110,160,80);
          SDL_RenderDrawLine(REN, (int)PX(s),(int)PY(s),
            (int)PX(systs[std::to_string(c)]),(int)PY(systs[std::to_string(c)]));
        }
      }
    auto lk = g.linked();
    for (auto& [id,s] : systs.items()) {
      int iid = std::stoi(id);
      double x = PX(s), y = PY(s);
      bool known = g.explored.count(iid), adj = std::find(lk.begin(),lk.end(),iid)!=lk.end();
      SDL_Color c = known ? govtColor(s["Govt"].get<int>()) : SDL_Color{120,130,150,90};
      SDL_SetRenderDrawColor(REN,c.r,c.g,c.b,c.a);
      SDL_Rect d{(int)x-2,(int)y-2, known?5:3, known?5:3}; SDL_RenderFillRect(REN,&d);
      if (iid == g.systId) { SDL_SetRenderDrawColor(REN,255,255,255,255); SDL_Rect o{(int)x-6,(int)y-6,12,12}; SDL_RenderDrawRect(REN,&o); }
      if (iid == g.jumpDest) { SDL_SetRenderDrawColor(REN,255,212,121,255); SDL_Rect o{(int)x-6,(int)y-6,12,12}; SDL_RenderDrawRect(REN,&o); }
      if (adj) {
        int cid = iid;
        gButtons.push_back({ SDL_Rect{(int)x-10,(int)y-10,20,20}, [this,cid]{ g.jumpDest = cid; } });
      }
      if (known || adj)
        drawText((int)x+8, (int)y-3, asciify(s["name"].is_string()?s["name"].get<std::string>():id),
                 known ? SDL_Color{207,214,228,255} : SDL_Color{122,134,156,255});
    }
    drawText(mx+12, my+mh-16,
      asciify(g.syst["name"].get<std::string>()) + " - click a linked system, then J to jump" +
      (g.fuel < JUMP_FUEL ? "  (out of fuel!)" : ""), GREY);
  }

  /* landing screen + service dialogs */
  void drawCard(int x, int y, int w, int h) {
    SDL_SetRenderDrawColor(REN, 12,17,32,255); SDL_Rect r{x,y,w,h}; SDL_RenderFillRect(REN,&r);
    SDL_SetRenderDrawColor(REN, 42,53,80,255); SDL_RenderDrawRect(REN,&r);
  }
  void dim(int w, int h, Uint8 a) {
    SDL_SetRenderDrawColor(REN, 0,0,0,a); SDL_Rect r{0,0,w,h}; SDL_RenderFillRect(REN,&r);
  }

  void drawLanded(int w, int h) {
    dim(w, h, 185);
    const Spob& p = *g.landedAt;
    int cw = 480, ch = 470, cx = (w-cw)/2, cy = (h-ch)/2;
    drawCard(cx, cy, cw, ch);
    int y = cy + 14;
    int scape = p.custPic >= 0 ? p.custPic : 10000 + p.type;
    Tex* t = tex.get(titlePath("PICT_" + std::to_string(scape) + ".png"));
    if (!t && p.custPic >= 0) t = tex.get(titlePath("PICT_" + std::to_string(10000 + p.type) + ".png"));
    if (t) {
      int iw = cw - 28, ih = (int)(iw * (double)t->h / t->w);
      SDL_Rect d{cx+14, y, iw, std::min(ih, 200)};
      SDL_RenderCopy(REN, t->t, nullptr, &d);
      y += d.h + 10;
    }
    drawText(cx+16, y, p.name, WHITE, 2); y += 20;
    drawText(cx+16, y, p.meta, DGREY); y += 14;
    std::string ww = wrap(p.landDesc, 56);
    size_t pos = 0; int lines = 0;
    while (pos != std::string::npos && lines < 6) {
      size_t nl = ww.find('\n', pos);
      drawText(cx+16, y, ww.substr(pos, nl==std::string::npos?nl:nl-pos), {170,182,204,255});
      pos = nl==std::string::npos?nl:nl+1; y += 11; lines++;
    }
    y += 8;
    int bx = cx + 16;
    if (p.exchange)  { button(bx, y, 120, 22, "Exchange",  true, [this]{ g.service="exchange"; }); bx += 128; }
    if (p.outfitter) { button(bx, y, 100, 22, "Outfitter", true, [this]{ g.service="outfitter"; }); bx += 108; }
    if (p.shipyard)  { button(bx, y, 100, 22, "Shipyard",  true, [this]{ g.service="shipyard"; }); bx += 108; }
    if (p.bar)       { button(bx, y, 60, 22, "Bar", false, []{}); }
    y += 34;
    drawText(cx+16, y, commas(g.credits) + " credits - cargo " +
      std::to_string(g.cargoUsed()) + "/" + std::to_string(g.holds) + " tons - fuel topped up", GREY);
    drawText(cx+16, cy+ch-24, "Esc: take off", GOLD);
  }

  void drawExchange(int w, int h) {
    dim(w, h, 120);
    int cw = 470, ch = 320, cx = (w-cw)/2, cy = (h-ch)/2;
    drawCard(cx, cy, cw, ch);
    drawText(cx+16, cy+14, "Commodity Exchange", WHITE, 2);
    drawText(cx+16, cy+34, g.landedAt->name + " - prices per ton", DGREY);
    int y = cy + 56;
    for (int i = 0; i < 6; i++) {
      int price = g.priceAt(*g.landedAt, i);
      if (price < 0 && !g.cargo[i]) continue;
      drawText(cx+16, y+4, g.data.str(4000, i) +
        (g.landedAt->prices[i].empty() ? "" : " (" + g.landedAt->prices[i] + ")"), {207,214,228,255});
      drawText(cx+190, y+4, price>=0 ? std::to_string(price)+" cr" : "-", GREY);
      drawText(cx+265, y+4, std::to_string(g.cargo[i]), WHITE);
      if (price >= 0) {
        int i2 = i;
        button(cx+300, y, 34, 18, "-10", g.cargo[i]>0, [this,i2]{ g.trade(i2,-10); });
        button(cx+337, y, 26, 18, "-1", g.cargo[i]>0, [this,i2]{ g.trade(i2,-1); });
        button(cx+366, y, 26, 18, "+1", g.cargoUsed()<g.holds && g.credits>=price, [this,i2]{ g.trade(i2,1); });
        button(cx+395, y, 34, 18, "+10", g.cargoUsed()<g.holds && g.credits>=price, [this,i2]{ g.trade(i2,10); });
      }
      y += 26;
    }
    drawText(cx+16, cy+ch-52, commas(g.credits) + " credits - cargo " +
      std::to_string(g.cargoUsed()) + "/" + std::to_string(g.holds) + " tons", GREY);
    button(cx+16, cy+ch-32, 90, 22, "Done (Esc)", true, [this]{ g.service.clear(); });
  }

  /* classic grid shops: sheets PICT 5100 (ships) / 6100 (outfits), 32×32
   * cells, 8 columns; detail art PICT 5000+i / 6000+i (100×100) */
  void drawShop(int w, int h, bool yard) {
    dim(w, h, 120);
    int cw = 620, ch = 430, cx = (w-cw)/2, cy = (h-ch)/2;
    drawCard(cx, cy, cw, ch);
    const Spob& p = *g.landedAt;
    drawText(cx+16, cy+14, yard ? "Shipyard" : "Outfitter", WHITE, 2);
    std::string sub = p.name + " - tech " + std::to_string(p.techLevel);
    if (yard) sub += " - trade-in: 25% = " + commas(g.tradeIn()) + " cr";
    drawText(cx+16, cy+34, sub, DGREY);

    Tex* sheet = tex.get(gfxPath(yard ? "PICT_5100.png" : "PICT_6100.png"));
    auto& table = g.data.db["types"][yard ? "ship" : "outf"];
    int& sel = yard ? g.selShip : g.selOutfit;

    // collect + default selection
    std::vector<std::pair<int,bool>> items; // id, avail
    for (auto& [id, r] : table.items()) {
      if (r["MissionBit"].get<int>() >= 0) continue;
      int iid = std::stoi(id);
      bool avail = g.techOK(r["TechLevel"].get<int>(), p) ||
                   (!yard && g.outfits.count(iid) && g.outfits[iid] > 0);
      items.push_back({iid, avail});
    }
    bool selOk = false;
    for (auto& [iid, av] : items) if (iid == sel && av) selOk = true;
    if (!selOk) { sel = -1; for (auto& [iid, av] : items) if (av) { sel = iid; break; } }

    // grid
    int gx = cx + 16, gy = cy + 54;
    for (auto& [iid, avail] : items) {
      int i = iid - 128, col = i % 8, row = i / 8;
      SDL_Rect cell{gx + col*34, gy + row*34, 32, 32};
      if (sheet) {
        SDL_Rect src{col*32, row*32, 32, 32};
        if (!avail) SDL_SetTextureAlphaMod(sheet->t, 70);
        SDL_RenderCopy(REN, sheet->t, &src, &cell);
        SDL_SetTextureAlphaMod(sheet->t, 255);
      }
      SDL_SetRenderDrawColor(REN, iid==sel?255:38, iid==sel?212:48, iid==sel?121:74, 255);
      SDL_RenderDrawRect(REN, &cell);
      if (avail) {
        int cid = iid;
        gButtons.push_back({cell, [&sel, cid]{ sel = cid; }});
      }
    }

    // detail pane
    if (sel >= 0) {
      int dx = cx + 16 + 8*34 + 16, dy = cy + 54, dw = cw - (dx - cx) - 16;
      auto& r = table[std::to_string(sel)];
      Tex* art = tex.get(gfxPath("PICT_" + std::to_string((yard?5000:6000) + (sel-128)) + ".png"));
      if (art) { SDL_Rect d{dx + dw - 100, dy, 100, 100}; SDL_RenderCopy(REN, art->t, nullptr, &d); }
      std::string name = yard ? g.data.str(5001, sel-128) : g.data.str(5000, sel-128);
      if (name.empty()) name = asciify(r["name"].is_string()?r["name"].get<std::string>():"#"+std::to_string(sel));
      drawText(dx, dy, name, WHITE);
      int y = dy + 16;
      auto row = [&](const std::string& s) { drawText(dx, y, s, {170,182,204,255}); y += 12; };
      if (yard) {
        bool own = sel == g.playerShipId;
        long long net = (long long)g.num(r,"Cost") - g.tradeIn();
        row("Cost: " + commas((long long)g.num(r,"Cost")) + (own ? " (current)" : " - net " + commas(net)));
        row("Shield " + std::to_string((int)g.num(r,"Shield")) + "  Armor " + std::to_string((int)g.num(r,"Armor")));
        row("Speed " + std::to_string((int)g.num(r,"Speed")) + "  Accel " + std::to_string((int)g.num(r,"Accel")) +
            "  Turn " + std::to_string((int)g.num(r,"Maneuver")));
        row("Cargo " + std::to_string((int)g.num(r,"Holds")) + "t  Space " + std::to_string((int)g.num(r,"FreeMass")) + "t");
        row("Fuel " + std::to_string((int)g.num(r,"Fuel")/100) + " jumps  Crew " + std::to_string((int)g.num(r,"Crew")));
        row("Guns " + std::to_string((int)g.num(r,"MaxGun")) + "  Turrets " + std::to_string((int)g.num(r,"MaxTur")));
        y += 6;
        int sid = sel;
        button(dx, y, 60, 22, "Buy", !own && g.credits >= net, [this,sid]{ g.buyShip(sid); });
      } else {
        auto e = g.effective();
        int own = g.outfits.count(sel) ? g.outfits[sel] : 0;
        int cost = (int)g.num(r,"Cost"), mass = (int)g.num(r,"Mass"), mx = (int)g.num(r,"Max");
        std::string mt = r["$sem"]["modType"].is_string()?r["$sem"]["modType"].get<std::string>():"";
        row(mt + (mx>0 ? " - max " + std::to_string(mx) : ""));
        row("Cost: " + commas(cost) + " cr");
        row("Mass: " + std::to_string(mass) + " tons");
        row("Owned: " + std::to_string(own));
        y += 6;
        bool canBuy = g.techOK(r["TechLevel"].get<int>(), p) && g.credits >= cost &&
          (mx <= 0 || own < mx) && (mass <= 0 || e.freeMass >= mass);
        int oid = sel;
        button(dx, y, 60, 22, "Buy", canBuy, [this,oid]{ g.buyOutfit(oid, 1); });
        button(dx+66, y, 60, 22, "Sell", own > 0, [this,oid]{ g.buyOutfit(oid, -1); });
      }
    }
    drawText(cx+16, cy+ch-52, commas(g.credits) + " credits - cargo " +
      std::to_string(g.cargoUsed()) + "/" + std::to_string(g.holds) + " tons - " +
      std::to_string(g.effective().freeMass) + "t outfit space", GREY);
    button(cx+16, cy+ch-32, 90, 22, "Done (Esc)", true, [this]{ g.service.clear(); });
  }

  void render(int w, int h) {
    gButtons.clear();
    SDL_SetRenderDrawColor(REN, 0, 0, 0, 255);
    SDL_RenderClear(REN);
    int streak = g.jump.active && g.jump.streak ? g.jump.t : 0;
    drawStars(w, h, streak);
    auto sx = [&](double x){ return x - g.player.x + w/2.0; };
    auto sy = [&](double y){ return y - g.player.y + h/2.0; };

    for (auto& p : g.spobs) {
      drawSpin(spobSpin(p), sx(p.x), sy(p.y), 0);
      drawTextC((int)sx(p.x), (int)sy(p.y)+44, p.name, {190,205,230,140});
      if (&p == g.navTarget)
        drawBrackets(sx(p.x), sy(p.y), spinHalf(spobSpin(p), 48),
          p.canLand ? SDL_Color{120,230,140,230} : SDL_Color{150,160,180,180});
    }
    for (auto& s : g.ai) {
      double x = sx(s.x), y = sy(s.y);
      if (x < -100 || x > w+100 || y < -100 || y > h+100) continue;
      if (s.deathT >= 0 && s.deathT % 4 < 2) continue; // disintegration flicker
      Tex* t = tex.get(spinPath(shipSpin(s.shipId)));
      if (t && s.state == Entity::LANDING) SDL_SetTextureAlphaMod(t->t, (Uint8)(255*std::max(s.fade,0.0)));
      if (t && s.disabled) SDL_SetTextureAlphaMod(t->t, 150);
      drawSpin(shipSpin(s.shipId), x, y, s.heading);
      if (t) SDL_SetTextureAlphaMod(t->t, 255);
      auto it = g.spins.find(shipSpin(s.shipId));
      drawFlame(s, x, y, it != g.spins.end() ? it->second.frameH : 24);
      if (&s == g.shipTarget)
        drawBrackets(x, y, spinHalf(shipSpin(s.shipId), 32),
          s.hostile ? SDL_Color{224,108,117,230} : SDL_Color{255,212,121,230});
    }
    if (!g.landedAt && !g.gameOver && !(g.player.deathT >= 0 && g.player.deathT % 4 < 2)) {
      drawSpin(shipSpin(g.playerShipId), w/2.0, h/2.0, g.player.heading);
      auto it = g.spins.find(shipSpin(g.playerShipId));
      drawFlame(g.player, w/2.0, h/2.0, it != g.spins.end() ? it->second.frameH : 24);
    }

    /* beams, shots, explosions */
    for (auto& b : g.beams) {
      static const std::map<int, SDL_Color> BC = {
        {-2,{255,80,80,255}},{-3,{80,255,112,255}},{-4,{80,128,255,255}},
        {-5,{80,255,255,255}},{-6,{255,80,255,255}},{-7,{255,255,80,255}}};
      int gcode = (int)g.num(*b.rec, "Graphic");
      SDL_Color c = BC.count(gcode) ? BC.at(gcode) : SDL_Color{255,255,255,255};
      SDL_SetRenderDrawColor(REN, c.r, c.g, c.b, 255);
      double a = d2r(b.heading), len = b.len > 0 ? b.len : g.num(*b.rec, "Speed");
      double x1 = sx(b.owner->x), y1 = sy(b.owner->y);
      SDL_RenderDrawLine(REN, (int)x1, (int)y1,
        (int)(x1 + std::sin(a) * len), (int)(y1 - std::cos(a) * len));
    }
    for (auto& shp : g.shots) {
      double x = sx(shp.x), y = sy(shp.y);
      if (x < -40 || x > w+40 || y < -40 || y > h+40) continue;
      int spin = 200 + shp.graphic;
      if (g.spins.count(spin)) drawSpin(spin, x, y, shp.heading);
      else { SDL_SetRenderDrawColor(REN,255,255,255,255); SDL_Rect d{(int)x-1,(int)y-1,2,2}; SDL_RenderFillRect(REN,&d); }
    }
    for (auto& ex : g.explosions) {
      auto it = g.spins.find(ex.spin);
      Tex* t = tex.get(spinPath(ex.spin));
      if (it == g.spins.end() || !t) continue;
      const SpinMeta& m = it->second;
      int fi = std::min(ex.f, m.frames - 1);
      SDL_Rect srcr{ (fi % m.xTiles) * m.frameW, (fi / m.xTiles) * m.frameH, m.frameW, m.frameH };
      SDL_Rect dst{ (int)(sx(ex.x) - m.frameW/2.0), (int)(sy(ex.y) - m.frameH/2.0), m.frameW, m.frameH };
      SDL_RenderCopy(REN, t->t, &srcr, &dst);
    }
    drawPanel(w, h);

    /* HUD topleft */
    double speed = std::hypot(g.player.vx, g.player.vy) * FPS;
    char hud[160];
    std::snprintf(hud, sizeof hud, "%s\n%s\nspeed %.0f px/s",
      asciify(g.syst["name"].get<std::string>()).c_str(),
      asciify(g.data.ship(g.playerShipId)["name"].get<std::string>()).c_str(), speed);
    drawText(12, 10, hud, GREY);

    /* prompt + message */
    if (g.jump.active && !g.jump.streak)
      drawTextC(w/2, h-96, "Jump autopilot engaged - Esc to abort", GOLD);
    else if (!g.landedAt && g.navTarget && g.navTarget->canLand &&
             g.distTo(g.navTarget->x, g.navTarget->y) < LAND_DIST)
      drawTextC(w/2, h-96,
        (std::hypot(g.player.vx,g.player.vy) > LAND_SPEED ? "Slow down to land on " : "Press L to land on ")
        + g.navTarget->name, GOLD);
    if (g.msgTtl > 0 && !g.message.empty())
      drawTextC(w/2, h-120, g.message, {159,180,216,255});

    if (g.mapOpen) drawMap(w, h);
    if (g.landedAt) {
      drawLanded(w, h);
      if (g.service == "exchange") drawExchange(w, h);
      else if (g.service == "outfitter") drawShop(w, h, false);
      else if (g.service == "shipyard") drawShop(w, h, true);
    }
    if (g.gameOver) {
      dim(w, h, 150);
      drawTextC(w/2, h/2 - 20, "Your ship has been destroyed.", {224,108,117,255}, 2);
      drawTextC(w/2, h/2 + 8, "Press R to try again", GOLD);
    }
    drawText(12, h-18,
      "arrows fly  Space fire  Q/X secondary  L land  N/Tab target  Y hail  M map  J jump  Esc",
      {77,91,118,255});
  }
};

/* ================= main ================= */

int main(int argc, char** argv) {
  int systId = 128, shipId = 128, shotFrames = -1, destArg = -1;
  bool forceThrust = false, fMap = false, fJump = false, fLand = false,
       fTab = false, fNav = false, fFire = false;
  std::string fService;
  double px = 0, py = 300, ph = 0;
  std::string root = ".", shotPath;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto next = [&]{ return std::string(argv[++i]); };
    if (a == "--syst") systId = std::stoi(next());
    else if (a == "--ship") shipId = std::stoi(next());
    else if (a == "--x") px = std::stod(next());
    else if (a == "--y") py = std::stod(next());
    else if (a == "--heading") ph = std::stod(next());
    else if (a == "--root") root = next();
    else if (a == "--frames") shotFrames = std::stoi(next());
    else if (a == "--screenshot") shotPath = next();
    else if (a == "--thrust") forceThrust = true;
    else if (a == "--trace") return runTrace(next());
    else if (a == "--map") fMap = true;
    else if (a == "--dest") destArg = std::stoi(next());
    else if (a == "--jump") fJump = true;
    else if (a == "--land") fLand = true;
    else if (a == "--exchange" || a == "--outfitter" || a == "--shipyard") fService = a.substr(2);
    else if (a == "--tab") fTab = true;
    else if (a == "--nav") fNav = true;
    else if (a == "--fire") fFire = true;
    else { std::fprintf(stderr, "unknown arg %s\n", a.c_str()); return 1; }
  }

  Game g{ GameData::load(root) };
  g.playerShipId = shipId;
  g.loadSystem(systId);
  auto& rec = g.data.ship(shipId);
  if (rec.is_null()) { std::fprintf(stderr, "no ship %d\n", shipId); return 1; }
  g.player.shipId = shipId;
  g.player.x = px; g.player.y = py; g.player.heading = norm360(ph);
  g.applyStats();
  g.fuel = g.fuelMax;

  SDL_Init(SDL_INIT_VIDEO);
  SDL_Window* win = SDL_CreateWindow("V_e (SDL)", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
    WIN_W, WIN_H, 0);
  REN = SDL_CreateRenderer(win, -1,
    shotPath.empty() ? SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC : SDL_RENDERER_SOFTWARE);
  SDL_SetRenderDrawBlendMode(REN, SDL_BLENDMODE_BLEND);
  Renderer r{ g, g.tex, root };
  g.tex.ren = REN;

  /* test-affordance flags (parity with the browser URL params) */
  if (fMap) g.mapOpen = true;
  if (destArg >= 0) g.jumpDest = destArg;
  if (fJump) g.beginJump();
  if (fLand) { g.tryLand(); g.tryLand(); }
  if (!fService.empty()) g.service = fService;
  if (fTab) g.cycleShip();
  if (fNav) g.cyclePlanet();
  g.fireHeld = fFire;

  bool quit = false;
  Uint64 lastMs = SDL_GetTicks64();
  double acc = 0;
  int frameCount = 0;

  while (!quit) {
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) {
      if (ev.type == SDL_QUIT) quit = true;
      if (ev.type == SDL_MOUSEBUTTONDOWN) {
        SDL_Point pt{ev.button.x, ev.button.y};
        for (auto& b : gButtons)
          if (SDL_PointInRect(&pt, &b.r)) { b.fn(); break; }
      }
      if (ev.type == SDL_KEYDOWN && !ev.key.repeat) {
        SDL_Keycode k = ev.key.keysym.sym;
        if (k == SDLK_l) g.tryLand();
        else if (k == SDLK_r && g.gameOver) {           // restart
          g.gameOver = false;
          g.credits = 10000;
          for (int& c : g.cargo) c = 0;
          g.outfits.clear();
          g.playerShipId = g.player.shipId = shipId;
          g.applyStats();
          g.player.x = 0; g.player.y = 300; g.player.heading = 0;
          g.player.vx = g.player.vy = 0;
          g.loadSystem(systId);
          g.fuel = g.fuelMax;
        }
        else if (k == SDLK_q && !g.landedAt) {          // cycle secondary
          std::vector<int> secs;
          for (auto& w : g.player.weapons)
            if ((int)g.num(*w.rec, "MiscFlags") & 2) secs.push_back(w.id);
          if (secs.empty()) g.showMsg("No secondary weapons fitted.");
          else {
            auto it2 = std::find(secs.begin(), secs.end(), g.player.selSecondary);
            g.player.selSecondary = secs[(it2 == secs.end() ? 0 : (it2 - secs.begin() + 1)) % secs.size()];
            g.showMsg("Secondary: " + asciify(g.data.rec("weap", g.player.selSecondary)["name"].get<std::string>()));
          }
        }
        else if (k == SDLK_m) g.mapOpen = !g.mapOpen;
        else if (k == SDLK_j) { if (g.mapOpen) g.mapOpen = false; g.beginJump(); }
        else if (k == SDLK_n && !g.landedAt) g.cyclePlanet();
        else if (k == SDLK_y && !g.landedAt) g.hail();
        else if (k == SDLK_TAB && !g.landedAt) g.cycleShip();
        else if (k == SDLK_ESCAPE) {
          if (!g.service.empty()) g.service.clear();
          else if (g.mapOpen) g.mapOpen = false;
          else if (g.jump.active && !g.jump.streak) g.jump = {};
          else if (g.landedAt) g.takeOff();
          else if (g.shipTarget) { g.shipTarget = nullptr; g.showMsg("Target cleared."); }
          else if (g.navTarget) { g.navTarget = nullptr; g.showMsg("Navigation target cleared."); }
          else quit = true;
        }
      }
    }

    Uint64 now = SDL_GetTicks64();
    acc += std::min<double>(now - lastMs, 250);
    lastMs = now;
    const double dt = 1000.0 / FPS;
    const Uint8* keys = SDL_GetKeyboardState(nullptr);
    while (acc >= dt) { g.step(keys, forceThrust); acc -= dt; frameCount++; }
    if (shotFrames >= 0)
      while (frameCount < shotFrames) { g.step(keys, forceThrust); frameCount++; }

    r.render(WIN_W, WIN_H);

    if (!shotPath.empty() && frameCount >= std::max(shotFrames, 0)) {
      std::vector<unsigned char> pix((size_t)WIN_W * WIN_H * 4);
      SDL_RenderReadPixels(REN, nullptr, SDL_PIXELFORMAT_RGBA32, pix.data(), WIN_W * 4);
      stbi_write_png(shotPath.c_str(), WIN_W, WIN_H, 4, pix.data(), WIN_W * 4);
      std::printf("wrote %s after %d logic frames\n", shotPath.c_str(), frameCount);
      break;
    }
    SDL_RenderPresent(REN);
  }
  SDL_DestroyRenderer(REN);
  SDL_DestroyWindow(win);
  SDL_Quit();
  return 0;
}
