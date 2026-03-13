import { useState, useEffect, useCallback } from "react";

const API_BASE = "http://localhost:3001";

const CATEGORIES = [
  { id: "vitamins", name: "Vitamins", icon: "💊" },
  { id: "protein", name: "Protein", icon: "💪" },
  { id: "omega", name: "Omega", icon: "🐟" },
  { id: "probiotics", name: "Probiotics", icon: "🦠" },
  { id: "collagen", name: "Collagen", icon: "✨" },
  { id: "magnesium", name: "Magnesium", icon: "⚡" },
  { id: "vitaminD", name: "Vitamin D", icon: "☀️" },
  { id: "vitaminC", name: "Vitamin C", icon: "🍋" },
];

const formatPrice = (attrs) => {
  const price = attrs?.list_price?.[0]?.value?.amount || attrs?.price?.[0]?.value;
  return price ? `$${parseFloat(price).toFixed(2)}` : "N/A";
};

const getBrand = (attrs) => attrs?.brand?.[0]?.value || "Unknown Brand";
const getTitle = (summaries) => summaries?.[0]?.itemName || "Unknown Product";
const getRank = (salesRanks) => salesRanks?.[0]?.ranks?.[0]?.rank || null;
const getImage = (images) => images?.[0]?.images?.[0]?.link || null;

export default function SuppleMint() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [activeCategory, setActiveCategory] = useState("vitamins");
  const [products, setProducts] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [apiStatus, setApiStatus] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [stats, setStats] = useState({ total: 0, brands: 0, avgRank: 0 });

  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((r) => r.json())
      .then(setApiStatus)
      .catch(() => setApiStatus({ status: "error", mode: "offline" }));
  }, []);

  useEffect(() => {
    if (activeTab === "browse") loadCategory(activeCategory);
  }, [activeCategory, activeTab]);

  const loadCategory = async (cat) => {
    setLoading(true);
    setProducts([]);
    try {
      const r = await fetch(`${API_BASE}/api/products/${cat}`);
      const data = await r.json();
      const items = data.items || [];
      setProducts(items);
      const brands = new Set(items.map((p) => getBrand(p.attributes)));
      const ranks = items.map((p) => getRank(p.salesRanks)).filter(Boolean);
      setStats({
        total: data.numberOfResults || items.length,
        brands: brands.size,
        avgRank: ranks.length ? Math.round(ranks.reduce((a, b) => a + b, 0) / ranks.length) : 0,
      });
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setSearchResults([]);
    try {
      const r = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await r.json();
      setSearchResults(data.items || []);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const StatusBadge = () => (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      background: apiStatus?.mode === "live" ? "rgba(34,197,94,0.15)" : "rgba(251,191,36,0.15)",
      border: `1px solid ${apiStatus?.mode === "live" ? "#22c55e" : "#fbbf24"}`,
      borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600,
      color: apiStatus?.mode === "live" ? "#22c55e" : "#fbbf24"
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%",
        background: apiStatus?.mode === "live" ? "#22c55e" : "#fbbf24",
        animation: "pulse 2s infinite"
      }} />
      {apiStatus?.mode === "live" ? "LIVE" : apiStatus?.mode?.toUpperCase() || "CONNECTING..."}
    </div>
  );

  const ProductCard = ({ product, onClick }) => {
    const title = getTitle(product.summaries);
    const brand = getBrand(product.attributes);
    const rank = getRank(product.salesRanks);
    const image = getImage(product.images);
    const price = formatPrice(product.attributes);

    return (
      <div onClick={() => onClick(product)} style={{
        background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12, padding: 16, cursor: "pointer", transition: "all 0.2s",
        display: "flex", flexDirection: "column", gap: 10,
      }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.08)"}
        onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.04)"}
      >
        {image && (
          <div style={{ width: "100%", height: 140, borderRadius: 8, overflow: "hidden", background: "#fff" }}>
            <img src={image} alt={title} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          </div>
        )}
        <div>
          <div style={{ fontSize: 11, color: "#6ee7b7", fontWeight: 700, marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>{brand}</div>
          <div style={{ fontSize: 13, color: "#e2e8f0", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{title}</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto" }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{price}</span>
          {rank && <span style={{ fontSize: 11, color: "#94a3b8", background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: 10 }}>#{rank.toLocaleString()}</span>}
        </div>
        <div style={{ fontSize: 11, color: "#64748b" }}>ASIN: {product.asin}</div>
      </div>
    );
  };

  const ProductModal = ({ product, onClose }) => {
    if (!product) return null;
    const title = getTitle(product.summaries);
    const brand = getBrand(product.attributes);
    const image = getImage(product.images);
    const price = formatPrice(product.attributes);
    const rank = getRank(product.salesRanks);
    const bullets = product.attributes?.bullet_point?.slice(0, 5) || [];

    return (
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24
      }}>
        <div onClick={e => e.stopPropagation()} style={{
          background: "#0f172a", border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 20, padding: 32, maxWidth: 600, width: "100%", maxHeight: "80vh",
          overflowY: "auto"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: "#6ee7b7", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{brand}</div>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 20 }}>✕</button>
          </div>
          {image && (
            <div style={{ width: "100%", height: 220, borderRadius: 12, overflow: "hidden", background: "#fff", marginBottom: 20 }}>
              <img src={image} alt={title} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            </div>
          )}
          <h2 style={{ color: "#f1f5f9", fontSize: 18, lineHeight: 1.5, marginBottom: 16 }}>{title}</h2>
          <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
            <div style={{ background: "rgba(110,231,183,0.1)", border: "1px solid rgba(110,231,183,0.2)", borderRadius: 10, padding: "10px 16px", flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#6ee7b7" }}>{price}</div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>List Price</div>
            </div>
            {rank && (
              <div style={{ background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 10, padding: "10px 16px", flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#818cf8" }}>#{rank.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>Sales Rank</div>
              </div>
            )}
            <div style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 10, padding: "10px 16px", flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fbbf24" }}>{product.asin}</div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>ASIN</div>
            </div>
          </div>
          {bullets.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>Key Features</div>
              {bullets.map((b, i) => (
                <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                  <span style={{ color: "#6ee7b7", flexShrink: 0 }}>▸</span>
                  <span style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.5 }}>{b.value}</span>
                </div>
              ))}
            </div>
          )}
          <a href={`https://www.amazon.com/dp/${product.asin}`} target="_blank" rel="noreferrer"
            style={{
              display: "block", marginTop: 20, background: "#ff9900", color: "#000",
              fontWeight: 700, padding: "12px 20px", borderRadius: 10, textAlign: "center",
              textDecoration: "none", fontSize: 14
            }}>
            View on Amazon →
          </a>
        </div>
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: "#020817", color: "#e2e8f0", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes spin { to{transform:rotate(360deg)} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #0f172a; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "rgba(2,8,23,0.95)", backdropFilter: "blur(20px)", zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, background: "linear-gradient(135deg, #6ee7b7, #3b82f6)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🌿</div>
          <div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 18, fontWeight: 700, color: "#fff", letterSpacing: -0.5 }}>SuppleMint</div>
            <div style={{ fontSize: 11, color: "#475569", letterSpacing: 2, textTransform: "uppercase" }}>Amazon Market Intelligence</div>
          </div>
        </div>
        <StatusBadge />
      </div>

      {/* Nav */}
      <div style={{ padding: "0 32px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 4 }}>
        {[["dashboard", "📊 Dashboard"], ["browse", "🔍 Browse"], ["search", "🔎 Search"]].map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)} style={{
            background: "none", border: "none", cursor: "pointer", padding: "14px 16px",
            fontSize: 13, fontWeight: 600, color: activeTab === id ? "#6ee7b7" : "#64748b",
            borderBottom: `2px solid ${activeTab === id ? "#6ee7b7" : "transparent"}`,
            transition: "all 0.2s"
          }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: 32 }}>

        {/* DASHBOARD TAB */}
        {activeTab === "dashboard" && (
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Market Overview</h1>
            <p style={{ color: "#64748b", marginBottom: 32 }}>Amazon US Dietary Supplement Intelligence</p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 40 }}>
              {[
                { label: "API Status", value: apiStatus?.mode === "live" ? "Live" : "Demo", color: "#6ee7b7", icon: "🔗" },
                { label: "Marketplace", value: "Amazon US", color: "#818cf8", icon: "🇺🇸" },
                { label: "Categories", value: "8", color: "#fbbf24", icon: "📂" },
                { label: "Data Source", value: "SP-API", color: "#f472b6", icon: "⚡" },
              ].map((s, i) => (
                <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: 20 }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>{s.icon}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>{s.label}</div>
                </div>
              ))}
            </div>

            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>Browse Categories</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
              {CATEGORIES.map(cat => (
                <button key={cat.id} onClick={() => { setActiveTab("browse"); setActiveCategory(cat.id); }} style={{
                  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 12, padding: "20px 16px", cursor: "pointer", textAlign: "center",
                  transition: "all 0.2s", color: "#e2e8f0"
                }}
                  onMouseEnter={e => { e.currentTarget.style.background = "rgba(110,231,183,0.08)"; e.currentTarget.style.borderColor = "rgba(110,231,183,0.3)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}
                >
                  <div style={{ fontSize: 32, marginBottom: 8 }}>{cat.icon}</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{cat.name}</div>
                  <div style={{ fontSize: 11, color: "#6ee7b7", marginTop: 4 }}>Browse →</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* BROWSE TAB */}
        {activeTab === "browse" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
              <div>
                <h1 style={{ fontSize: 24, fontWeight: 700, color: "#f1f5f9" }}>
                  {CATEGORIES.find(c => c.id === activeCategory)?.icon} {CATEGORIES.find(c => c.id === activeCategory)?.name}
                </h1>
                {stats.total > 0 && <p style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>{stats.total.toLocaleString()} products · {stats.brands} brands</p>}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 28, flexWrap: "wrap" }}>
              {CATEGORIES.map(cat => (
                <button key={cat.id} onClick={() => setActiveCategory(cat.id)} style={{
                  background: activeCategory === cat.id ? "rgba(110,231,183,0.15)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${activeCategory === cat.id ? "rgba(110,231,183,0.4)" : "rgba(255,255,255,0.08)"}`,
                  borderRadius: 20, padding: "6px 14px", cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  color: activeCategory === cat.id ? "#6ee7b7" : "#94a3b8",
                  transition: "all 0.2s"
                }}>{cat.icon} {cat.name}</button>
              ))}
            </div>

            {loading ? (
              <div style={{ textAlign: "center", padding: 80 }}>
                <div style={{ width: 40, height: 40, border: "3px solid rgba(110,231,183,0.2)", borderTopColor: "#6ee7b7", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 16px" }} />
                <div style={{ color: "#64748b" }}>Loading from Amazon SP-API...</div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
                {products.map(p => <ProductCard key={p.asin} product={p} onClick={setSelectedProduct} />)}
                {products.length === 0 && <div style={{ color: "#475569", gridColumn: "1/-1", textAlign: "center", padding: 60 }}>No products found</div>}
              </div>
            )}
          </div>
        )}

        {/* SEARCH TAB */}
        {activeTab === "search" && (
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#f1f5f9", marginBottom: 24 }}>🔎 Product Search</h1>
            <div style={{ display: "flex", gap: 12, marginBottom: 32 }}>
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSearch()}
                placeholder="Search Amazon supplements... (e.g. vitamin c 1000mg)"
                style={{
                  flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 10, padding: "12px 16px", color: "#e2e8f0", fontSize: 14, outline: "none"
                }}
              />
              <button onClick={handleSearch} style={{
                background: "linear-gradient(135deg, #6ee7b7, #3b82f6)", border: "none",
                borderRadius: 10, padding: "12px 24px", color: "#000", fontWeight: 700,
                cursor: "pointer", fontSize: 14
              }}>Search</button>
            </div>

            {loading ? (
              <div style={{ textAlign: "center", padding: 80 }}>
                <div style={{ width: 40, height: 40, border: "3px solid rgba(110,231,183,0.2)", borderTopColor: "#6ee7b7", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 16px" }} />
                <div style={{ color: "#64748b" }}>Searching Amazon...</div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
                {searchResults.map(p => <ProductCard key={p.asin} product={p} onClick={setSelectedProduct} />)}
                {searchResults.length === 0 && searchQuery && !loading && (
                  <div style={{ color: "#475569", gridColumn: "1/-1", textAlign: "center", padding: 60 }}>No results for "{searchQuery}"</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <ProductModal product={selectedProduct} onClose={() => setSelectedProduct(null)} />
    </div>
  );
}