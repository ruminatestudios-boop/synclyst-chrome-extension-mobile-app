/**
 * Marketplace field selectors (2026). Used by content-script.js per platform.
 * @type {Record<string, { title: string[]; description: string[]; price: string[] }>}
 */
var SYNCLYST_PLATFORM_MAPPERS = {
  shopify: {
    title: [
      'input[aria-label="Title"]',
      'input[aria-label="Product title"]',
      'input[aria-label*="product title" i]',
      'input[placeholder*="product title" i]',
      '[name="title"]',
      "#title",
      'input[name="title"]',
      'input[id*="ProductTitle" i]',
      'input[id*="productTitle" i]',
      'input[id*="ProductTitleField" i]',
      'input[aria-label*="title" i]',
      'textarea[aria-label*="title" i]',
      'textarea[name="title"]',
      'input[data-testid*="title" i]',
      'input[placeholder*="t-shirt" i]',
      'input[placeholder*="Short sleeve" i]',
    ],
    description: [
      ".ql-editor",
      '[name="description"]',
      'textarea[name="description"]',
      "#product-description",
      '[id="product-description"]',
      '[contenteditable="true"][role="textbox"]',
      ".ProseMirror",
      '[data-slate-editor="true"]',
      'div[aria-label*="description" i][contenteditable="true"]',
      '[class*="RichTextEditor"] [contenteditable="true"]',
      'div[contenteditable="true"][class*="rte"]',
      '[data-lexical-editor] [contenteditable="true"]',
    ],
    price: [
      'input[aria-label="Price"]',
      'input[aria-label*="price" i]',
      '[name="price"]',
      'input[name="price"]',
      'input[id*="price" i]',
      'input[data-testid*="price" i]',
    ],
  },
  ebay: {
    title: [
      'input[aria-label*="Item title" i]',
      'input[aria-label="Title"]',
      "#editpane_title",
      '[id="editpane_title"]',
      'input[name="title"]',
    ],
    description: [
      'textarea[aria-label*="description" i]',
      'textarea[aria-label*="item description" i]',
      'div[contenteditable="true"][aria-label*="description" i]',
      '[role="textbox"][aria-label*="description" i]',
      "#editpane_description",
      'textarea[name="description"]',
      'textarea[placeholder*="Write a detailed description" i]',
      'textarea[placeholder*="detailed description of your item" i]',
      'textarea[placeholder*="save time" i]',
      'textarea[placeholder*="let AI" i]',
      'textarea[placeholder*="AI draft" i]',
      'textarea[placeholder*="draft it for you" i]',
      'div[contenteditable="true"][data-placeholder*="detailed description" i]',
      '[data-testid*="description" i]',
    ],
    price: [
      "#editpane_price",
      '[id="editpane_price"]',
      'input[aria-label*="Buy it now" i]',
      'input[aria-label*="Buy It Now" i]',
      'input[aria-label*="Starting bid" i]',
      'input[aria-label*="start bid" i]',
      'input[aria-label*="price" i]',
      'input[name="price"]',
    ],
  },
  etsy: {
    title: [
      "#listing-title",
      'input[name="title"]',
      'input[aria-label="Title"]',
      'input[aria-label^="Title" i]',
      'input[data-testid*="title" i]',
      'input[id*="ListingTitle" i]',
      'input[id*="listing-title" i]',
      'input[placeholder*="title" i]',
    ],
    description: ['textarea[name="description"]', "#listing-description", ".wysiwyg textarea"],
    price: ['input[name="price"]', 'input[aria-label*="price" i]'],
  },
  /**
   * Vinted “Sell an item” (upload flow). SPA — content-script uses deep query + scored extras.
   * @see listing_extra.vinted from vision push: category, brand, size, shoulder_width_in, length_in, condition, material, colours
   */
  vinted: {
    title: [
      '[data-testid="upload-item-title"]',
      '[data-testid*="title" i]',
      'input[name="title"]',
      'input[id*="title" i]',
      'input[aria-label*="title" i]',
      'input[placeholder*="title" i]',
    ],
    description: [
      'textarea[name="description"]',
      '[data-testid="description-textarea"]',
      '[data-testid*="description" i]',
      'textarea[aria-label*="description" i]',
      'textarea[placeholder*="description" i]',
    ],
    price: [
      'input[name="price"]',
      '[data-testid="price-input"]',
      '[data-testid*="price" i]',
      'input[aria-label*="price" i]',
      'input[inputmode="decimal"]',
    ],
  },
  /**
   * Shopee Seller Centre — regional SPAs; labels vary by locale. Inspect your region’s add-product DOM to tighten.
   * Deep query is enabled for shopee in content-script (same as Shopify) so nested React trees still match.
   *
   * Mobile “Add Product” flow (typical order; * = required in app):
   *  1. * Product Media (1:1 main image + gallery)
   *  2. * Product Name
   *  3. * Product Description (often separate editor)
   *  4. * Category — hierarchical tree (primary → sub → leaf); not a single flat enum
   *  5.   GTIN (optional)
   *  6. * Price
   *  7. * Stock
   *  8. * Minimum purchase quantity
   *  9.   Wholesale (optional)
   * 10. * Shipping fee / weight / size
   * 11.   Condition
   * 12.   Pre-order, schedule publish, social share toggles (region-dependent)
   * Magic Fill maps title / description / price; content-script also attaches scan image(s) to Product Images +
   * Promotion Image file inputs when found. Optional listing_extra.shopee.additional_images[] for more photos.
   *
   * Seller Centre often uses a 2-step wizard: step 1 (name + images + promotion image), then “Next” opens a
   * larger form (price, shipping, category, …). Step 2 DOM differs — tune selectors when you have screenshots.
   *
   * listing_extra.shopee (optional): category_hint + category_search (vision hints only); category_id +
   * category_path when resolved (API / barcode / user UI); category_source, category_needs_confirmation,
   * barcode; display_title (manual Shopee product name override); weight_kg; parcel_*_cm; stock;
   * brand, sleeve_length, pattern, gender, material, occasion;
   * size_chart_pick_first;
   * item_without_gtin (default true). See docs/marketplace-category-strategy.md
   */
  shopee: {
    title: [
      'input[placeholder*="Product name" i]',
      'input[placeholder*="product name" i]',
      'input[placeholder*="Enter product name" i]',
      'input[placeholder*="ชื่อสินค้า" i]',
      'input[placeholder*="Nama Produk" i]',
      'input[aria-label*="product name" i]',
      'input[aria-label*="ชื่อสินค้า" i]',
      'input[data-cy*="name" i]',
      'input[id*="product" i][id*="name" i]',
      'input[name="name"]',
    ],
    description: [
      'textarea[placeholder*="Please enter product description" i]',
      'textarea[placeholder*="product description" i]',
      'textarea[placeholder*="description" i]',
      'textarea[placeholder*="รายละเอียด" i]',
      'textarea[aria-label*="Product Description" i]',
      'textarea[aria-label*="description" i]',
      'div[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][data-placeholder*="description" i]',
      ".ql-editor",
      '[class*="editor" i][contenteditable="true"]',
    ],
    price: [
      'input[placeholder*="price" i]',
      'input[placeholder*="ราคา" i]',
      'input[aria-label*="price" i]',
      'input[name="price"]',
      'input[id*="price" i]',
      'input[data-cy*="price" i]',
    ],
  },
  /**
   * Depop “List an item” (sell flow). React SPA — deep query in content-script.
   * Typical order: Photos (up to 8) → Description (1000 chars, hashtags) → Info (category, brand, condition) →
   * Enhance (color, source, age, style) → Item price → Shipping → Location → Post.
   * Many regions use a single description textarea; Magic Fill merges title + description there when needed.
   *
   * listing_extra.depop (optional): category, brand, condition, color, source, age (Modern|00s|90s|80s|70s|60s|50s|Antique), style, shipping_price,
   * country, offer_worldwide_shipping, additional_images[].
   * category: typed into the Category combobox; Magic Fill then clicks the best **Suggested** platform pill (e.g. + Men / T-shirts) so the choice validates.
   * condition (dropdown): Brand new | Like new | Used - Excellent | Used - Good | Used - Fair — inferred from scan text if omitted.
   * source (dropdown): Vintage | Preloved | Reworked / Upcycled | Custom | Handmade | Deadstock | Designer | Repaired.
   * If source is omitted, Magic Fill infers it from title/description/condition (vision text). See extension-review + popup mergeDepop.
   */
  depop: {
    title: [
      'input[placeholder*="title" i]',
      'input[name="title"]',
      'input[aria-label*="title" i]',
      'input[data-testid*="title" i]',
    ],
    description: [
      'textarea[placeholder*="small grey" i]',
      'textarea[placeholder*="Nike" i]',
      'textarea[placeholder*="eg." i]',
      'textarea[name="description"]',
      'textarea[aria-label*="Description" i]',
      'textarea[aria-label*="description" i]',
    ],
    price: [
      'input[aria-label*="Item price" i]',
      'input[aria-label*="item price" i]',
      'input[name="price"]',
      'input[inputmode="decimal"]',
      'input[aria-label*="price" i]',
    ],
  },
};

(function aliasGenericMarketplaces() {
  var s = SYNCLYST_PLATFORM_MAPPERS.shopify;
  var copy = {
    title: s.title.slice(),
    description: s.description.slice(),
    price: s.price.slice(),
  };
  ["amazon", "tiktok", "facebook", "lazada", "grailed"].forEach(function (k) {
    SYNCLYST_PLATFORM_MAPPERS[k] = {
      title: copy.title.slice(),
      description: copy.description.slice(),
      price: copy.price.slice(),
    };
  });
})();

function synclystDetectPlatformFromUrl(href) {
  try {
    const h = new URL(href).hostname.toLowerCase();
    if (h === "admin.shopify.com") return "shopify";
    if (h.includes("ebay.")) return "ebay";
    if (h.includes("etsy.")) return "etsy";
    if (h.includes("vinted.")) return "vinted";
    if (h.includes("depop.")) return "depop";
    if (h.includes("grailed.")) return "grailed";
    if (h.includes("lazada.") && (h.includes("sellercenter") || h.includes("seller"))) return "lazada";
    if (h.includes("shopee.") && (h.startsWith("seller.") || h.includes("banhang.shopee"))) return "shopee";
  } catch (e) {}
  return "shopify";
}
