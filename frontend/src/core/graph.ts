/**
 * Knowledge Graph: nodes (papers, methods, datasets) and edges (relationships)
 * stored in IndexedDB, with automatic extraction from paper cards and preset
 * data for the 3 demo papers.
 */

export type NodeType = "paper" | "method" | "dataset";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  /** Short description for the detail panel */
  description?: string;
  /** For paper nodes: itemKey; for method/dataset: null */
  itemKey?: string;
  /** For paper nodes: page references where this concept appears */
  pages?: number[];
  /** Visual properties */
  color?: string;
  size?: number;
}

export type EdgeType = "improves" | "uses" | "evaluates" | "extends" | "cites";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label: string;
  /** Optional: page reference in the source paper */
  page?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const DB_NAME = "scholarpi-graph";
const DB_VERSION = 1;
const STORE_NODES = "nodes";
const STORE_EDGES = "edges";

let db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_NODES)) {
        d.createObjectStore(STORE_NODES, { keyPath: "id" });
      }
      if (!d.objectStoreNames.contains(STORE_EDGES)) {
        d.createObjectStore(STORE_EDGES, { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function txAll<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>[]): Promise<T[]> {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const reqs = fn(s);
    const results: T[] = [];
    let done = 0;
    reqs.forEach((req) => {
      req.onsuccess = () => {
        results.push(req.result);
        if (++done === reqs.length) resolve(results);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

export async function getAllNodes(): Promise<GraphNode[]> {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE_NODES, "readonly");
    const s = t.objectStore(STORE_NODES);
    const req = s.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllEdges(): Promise<GraphEdge[]> {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE_EDGES, "readonly");
    const s = t.objectStore(STORE_EDGES);
    const req = s.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function loadGraph(): Promise<GraphData> {
  const [nodes, edges] = await Promise.all([getAllNodes(), getAllEdges()]);
  return { nodes, edges };
}

export async function saveNode(node: GraphNode): Promise<void> {
  await tx(STORE_NODES, "readwrite", (s) => s.put(node));
}

export async function saveEdge(edge: GraphEdge): Promise<void> {
  await tx(STORE_EDGES, "readwrite", (s) => s.put(edge));
}

export async function deleteNode(id: string): Promise<void> {
  await tx(STORE_NODES, "readwrite", (s) => s.delete(id));
}

export async function deleteEdge(id: string): Promise<void> {
  await tx(STORE_EDGES, "readwrite", (s) => s.delete(id));
}

export async function clearGraph(): Promise<void> {
  const d = await openDB();
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      const t = d.transaction(STORE_NODES, "readwrite");
      const req = t.objectStore(STORE_NODES).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }),
    new Promise<void>((resolve, reject) => {
      const t = d.transaction(STORE_EDGES, "readwrite");
      const req = t.objectStore(STORE_EDGES).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Extraction from paper cards

/**
 * Extract graph nodes and edges from a paper's metadata card.
 * Called when a card is generated or updated.
 */
export function extractFromCard(card: {
  itemKey: string;
  title: string;
  method?: string;
  datasets?: string;
  keywords?: string;
  summary?: string;
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Paper node
  nodes.push({
    id: `paper:${card.itemKey}`,
    type: "paper",
    label: card.title.slice(0, 40),
    description: card.summary,
    itemKey: card.itemKey,
    color: "#4a90e2",
    size: 20,
  });

  // Method nodes
  if (card.method) {
    const methods = card.method
      .split(/[;；,，、]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 50)
      .slice(0, 3);
    methods.forEach((m, i) => {
      const id = `method:${card.itemKey}:${i}`;
      nodes.push({
        id,
        type: "method",
        label: m,
        color: "#50c878",
        size: 14,
      });
      edges.push({
        id: `edge:${card.itemKey}:uses:${i}`,
        source: `paper:${card.itemKey}`,
        target: id,
        type: "uses",
        label: "使用",
      });
    });
  }

  // Dataset nodes
  if (card.datasets) {
    const datasets = card.datasets
      .split(/[;；,，、]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 50)
      .slice(0, 3);
    datasets.forEach((d, i) => {
      const id = `dataset:${card.itemKey}:${i}`;
      nodes.push({
        id,
        type: "dataset",
        label: d,
        color: "#ff6b6b",
        size: 14,
      });
      edges.push({
        id: `edge:${card.itemKey}:evaluates:${i}`,
        source: `paper:${card.itemKey}`,
        target: id,
        type: "evaluates",
        label: "评测于",
      });
    });
  }

  return { nodes, edges };
}

/**
 * Save extracted graph data to IndexedDB.
 */
export async function saveExtracted(card: Parameters<typeof extractFromCard>[0]): Promise<void> {
  const { nodes, edges } = extractFromCard(card);
  for (const node of nodes) await saveNode(node);
  for (const edge of edges) await saveEdge(edge);
}

// ---------------------------------------------------------------------------
// Preset graph for demo papers

/**
 * Build the preset graph for the 3 demo papers: Attention, ResNet, BERT.
 * Shows the evolution: ResNet → uses → Residual Connection
 *                       Transformer (Attention) → uses → Residual Connection
 *                       Transformer → extends → BERT
 */
export function buildPresetGraph(): GraphData {
  const nodes: GraphNode[] = [
    // Papers
    {
      id: "paper:1706.03762",
      type: "paper",
      label: "Attention Is All You Need",
      description: "提出 Transformer 架构，完全基于注意力机制，摒弃循环和卷积",
      itemKey: "1706.03762",
      pages: [1, 3, 5],
      color: "#4a90e2",
      size: 22,
    },
    {
      id: "paper:1512.03385",
      type: "paper",
      label: "Deep Residual Learning",
      description: "提出 ResNet，引入残差连接解决深度网络退化问题",
      itemKey: "1512.03385",
      pages: [1, 2, 4],
      color: "#4a90e2",
      size: 22,
    },
    {
      id: "paper:1810.04805",
      type: "paper",
      label: "BERT",
      description: "基于 Transformer 编码器的双向预训练语言模型",
      itemKey: "1810.04805",
      pages: [1, 3, 5],
      color: "#4a90e2",
      size: 22,
    },
    // Methods
    {
      id: "method:transformer",
      type: "method",
      label: "Transformer",
      description: "自注意力 + 位置编码 + 前馈网络，支持并行计算",
      color: "#50c878",
      size: 18,
    },
    {
      id: "method:residual",
      type: "method",
      label: "Residual Connection",
      description: "跳跃连接，允许梯度直接流向前面层，解决退化问题",
      color: "#50c878",
      size: 18,
    },
    {
      id: "method:self-attention",
      type: "method",
      label: "Self-Attention",
      description: "计算序列中每个位置与其他位置的注意力权重",
      color: "#50c878",
      size: 16,
    },
    {
      id: "method:pretrain-finetune",
      type: "method",
      label: "Pre-train + Fine-tune",
      description: "先在大规模语料预训练，再在下游任务微调",
      color: "#50c878",
      size: 16,
    },
    // Datasets
    {
      id: "dataset:imagenet",
      type: "dataset",
      label: "ImageNet",
      description: "1000 类图像分类基准，1.2M 训练样本",
      color: "#ff6b6b",
      size: 16,
    },
    {
      id: "dataset:wmt14",
      type: "dataset",
      label: "WMT14",
      description: "机器翻译基准（英德、英法）",
      color: "#ff6b6b",
      size: 16,
    },
    {
      id: "dataset:glue",
      type: "dataset",
      label: "GLUE",
      description: "9 个 NLP 任务的综合评测基准",
      color: "#ff6b6b",
      size: 16,
    },
  ];

  const edges: GraphEdge[] = [
    // Transformer uses self-attention and residual
    {
      id: "edge:transformer:uses:self-attention",
      source: "method:transformer",
      target: "method:self-attention",
      type: "uses",
      label: "核心组件",
      page: 3,
    },
    {
      id: "edge:transformer:uses:residual",
      source: "method:transformer",
      target: "method:residual",
      type: "uses",
      label: "采用",
      page: 4,
    },
    // Attention paper proposes Transformer
    {
      id: "edge:attention:proposes:transformer",
      source: "paper:1706.03762",
      target: "method:transformer",
      type: "uses",
      label: "提出",
      page: 3,
    },
    // ResNet proposes residual connection
    {
      id: "edge:resnet:proposes:residual",
      source: "paper:1512.03385",
      target: "method:residual",
      type: "uses",
      label: "提出",
      page: 2,
    },
    // ResNet evaluates on ImageNet
    {
      id: "edge:resnet:evaluates:imagenet",
      source: "paper:1512.03385",
      target: "dataset:imagenet",
      type: "evaluates",
      label: "评测于",
      page: 5,
    },
    // Attention evaluates on WMT14
    {
      id: "edge:attention:evaluates:wmt14",
      source: "paper:1706.03762",
      target: "dataset:wmt14",
      type: "evaluates",
      label: "评测于",
      page: 6,
    },
    // BERT extends Transformer
    {
      id: "edge:bert:extends:transformer",
      source: "paper:1810.04805",
      target: "method:transformer",
      type: "extends",
      label: "基于",
      page: 2,
    },
    // BERT uses pre-train + fine-tune
    {
      id: "edge:bert:uses:pretrain",
      source: "paper:1810.04805",
      target: "method:pretrain-finetune",
      type: "uses",
      label: "采用",
      page: 3,
    },
    // BERT evaluates on GLUE
    {
      id: "edge:bert:evaluates:glue",
      source: "paper:1810.04805",
      target: "dataset:glue",
      type: "evaluates",
      label: "评测于",
      page: 5,
    },
    // BERT cites Attention
    {
      id: "edge:bert:cites:attention",
      source: "paper:1810.04805",
      target: "paper:1706.03762",
      type: "cites",
      label: "引用",
      page: 1,
    },
  ];

  return { nodes, edges };
}

/**
 * Ensure the preset graph is loaded (idempotent).
 */
export async function ensurePresetGraph(): Promise<void> {
  const existing = await getAllNodes();
  if (existing.some((n) => n.itemKey === "1706.03762")) return; // already seeded
  const preset = buildPresetGraph();
  for (const node of preset.nodes) await saveNode(node);
  for (const edge of preset.edges) await saveEdge(edge);
}
