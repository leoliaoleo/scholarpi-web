/**
 * Knowledge Graph visualization: d3-force + SVG with drag, zoom, filter, search,
 * and bidirectional linking to the paper reader.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from "preact/hooks";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type SimulationNodeDatum, type SimulationLinkDatum } from "d3-force";
import { zoom as d3Zoom, zoomIdentity } from "d3-zoom";
import { select } from "d3-selection";
import "d3-transition";
import type { GraphData, GraphNode, GraphEdge, NodeType } from "../core/graph";
import { presetIds } from "../core/graph";
import { getItem, paperTitle } from "../core/paper";

interface Props {
  data: GraphData;
  onNodeClick?: (node: GraphNode) => void;
  onPaperNavigate?: (itemKey: string, page?: number) => void;
}

interface SimNode extends SimulationNodeDatum, GraphNode {}
interface SimEdge extends SimulationLinkDatum<SimNode> {
  id: string;
  type: string;
  label: string;
  page?: number;
}

const TYPE_COLORS: Record<NodeType, string> = {
  paper: "#4a90e2",
  method: "#50c878",
  dataset: "#ff6b6b",
};

const TYPE_LABELS: Record<NodeType, string> = {
  paper: "文献",
  method: "方法",
  dataset: "数据集",
};

const EDGE_LABELS: Record<string, string> = {
  uses: "使用",
  evaluates: "评测于",
  extends: "扩展",
  improves: "改进",
  cites: "引用",
};

export function GraphView({ data, onNodeClick, onPaperNavigate }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [filter, setFilter] = useState<Set<NodeType>>(new Set(["paper", "method", "dataset"]));
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState<Set<string>>(new Set());

  const filtered = useCallback(() => {
    const nodes = data.nodes.filter((n) => filter.has(n.type));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = data.edges.filter((e) => nodeIds.has(e.source as string) && nodeIds.has(e.target as string));
    return { nodes, edges };
  }, [data, filter]);

  // Search highlighting
  useEffect(() => {
    if (!search.trim()) {
      setHighlight(new Set());
      return;
    }
    const q = search.toLowerCase();
    const hits = new Set(
      filtered()
        .nodes.filter((n) => n.label.toLowerCase().includes(q) || (n.description || "").toLowerCase().includes(q))
        .map((n) => n.id),
    );
    setHighlight(hits);
  }, [search, filtered]);

  // D3 force simulation
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    svg.selectAll("*").remove();

    const width = svgRef.current.clientWidth || 800;
    const height = svgRef.current.clientHeight || 600;

    const { nodes: rawNodes, edges: rawEdges } = filtered();
    const nodes: SimNode[] = rawNodes.map((n) => ({ ...n, x: width / 2 + Math.random() * 100, y: height / 2 + Math.random() * 100 }));
    const edges: SimEdge[] = rawEdges.map((e) => ({ ...e, source: e.source as string, target: e.target as string }));

    const g = svg.append("g");

    // Zoom
    const zoomBehavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on("zoom", (event) => {
        g.attr("transform", event.transform.toString());
      });
    svg.call(zoomBehavior);

    // Arrow marker
    svg
      .append("defs")
      .append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 28)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#999");

    // Edges
    const link = g
      .append("g")
      .attr("class", "edges")
      .selectAll("line")
      .data(edges)
      .enter()
      .append("line")
      .attr("stroke", "#999")
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", 1.5)
      .attr("marker-end", "url(#arrow)");

    // Edge labels
    const linkLabel = g
      .append("g")
      .attr("class", "edge-labels")
      .selectAll("text")
      .data(edges)
      .enter()
      .append("text")
      .attr("font-size", 10)
      .attr("fill", "#666")
      .attr("text-anchor", "middle")
      .text((d) => EDGE_LABELS[d.type] || d.label);

    // Nodes
    const node = g
      .append("g")
      .attr("class", "nodes")
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("cursor", "pointer")
      .call(
        d3Drag<SVGGElement, SimNode>()
          .on("start", (event, d) => {
            if (!event.active) simRef.current?.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simRef.current?.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      )
      .on("click", (event, d) => {
        event.stopPropagation();
        setSelected(d);
        onNodeClick?.(d);
      });

    node
      .append("circle")
      .attr("r", (d) => d.size || 14)
      .attr("fill", (d) => d.color || TYPE_COLORS[d.type])
      .attr("stroke", "#fff")
      .attr("stroke-width", 2)
      .attr("opacity", (d) => (highlight.size === 0 || highlight.has(d.id) ? 1 : 0.3));

    node
      .append("text")
      .attr("dy", (d) => (d.size || 14) + 14)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("fill", "#333")
      .attr("pointer-events", "none")
      .text((d) => d.label.slice(0, 20))
      .attr("opacity", (d) => (highlight.size === 0 || highlight.has(d.id) ? 1 : 0.3));

    // Simulation
    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance(120),
      )
      .force("charge", forceManyBody().strength(-300))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collision", forceCollide<SimNode>().radius((d) => (d.size || 14) + 10))
      .on("tick", () => {
        link
          .attr("x1", (d) => (d.source as SimNode).x!)
          .attr("y1", (d) => (d.source as SimNode).y!)
          .attr("x2", (d) => (d.target as SimNode).x!)
          .attr("y2", (d) => (d.target as SimNode).y!);

        linkLabel
          .attr("x", (d) => ((d.source as SimNode).x! + (d.target as SimNode).x!) / 2)
          .attr("y", (d) => ((d.source as SimNode).y! + (d.target as SimNode).y!) / 2);

        node.attr("transform", (d) => `translate(${d.x},${d.y})`);
      });

    simRef.current = sim;

    return () => {
      sim.stop();
    };
  }, [filtered, highlight, onNodeClick]);

  const toggleFilter = (type: NodeType) => {
    const next = new Set(filter);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setFilter(next);
  };

  const resetZoom = () => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const zoomBehavior = d3Zoom<SVGSVGElement, unknown>().scaleExtent([0.3, 3]);
    svg.transition().duration(500).call(zoomBehavior.transform, zoomIdentity);
  };

  /** 两类来源可信度不同：预置示例是人工整理，自动提取来自元数据卡片、可能不完整。 */
  const prov = useMemo(() => {
    const ids = presetIds();
    const pn = data.nodes.filter((n) => ids.nodes.has(n.id)).length;
    const pe = data.edges.filter((e) => ids.edges.has(e.id)).length;
    return { pn, an: data.nodes.length - pn, pe, ae: data.edges.length - pe };
  }, [data]);

  return (
    <div class="graph-view">
      <div class="graph-toolbar">
        <input
          class="graph-search"
          type="text"
          placeholder="搜索节点..."
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
        <div class="graph-filters">
          {(["paper", "method", "dataset"] as NodeType[]).map((type) => (
            <button
              key={type}
              class={`graph-filter ${filter.has(type) ? "on" : ""}`}
              style={{ borderColor: TYPE_COLORS[type] }}
              onClick={() => toggleFilter(type)}
            >
              <span class="dot" style={{ background: TYPE_COLORS[type] }} />
              {TYPE_LABELS[type]}
            </button>
          ))}
        </div>
        <button class="graph-reset" onClick={resetZoom} title="重置视图" aria-label="重置图谱缩放与位置">
          ⟲
        </button>
      </div>

      <div class="graph-legend">
        <span class="gl-src">
          <b class="gl-badge preset">预置示例</b> {prov.pn} 节点 · {prov.pe} 关系（随站人工整理）
        </span>
        <span class="gl-src">
          <b class="gl-badge auto">自动提取</b> {prov.an} 节点 · {prov.ae} 关系（由知识库元数据卡片生成，可能不完整，点击节点可回原文核对）
        </span>
        <span class="gl-privacy">PDF 仅保存在本地浏览器，仅在调用 AI 时发送所选文本/截图</span>
      </div>

      <svg ref={svgRef} class="graph-svg" />

      {selected && (
        <NodeDetail
          node={selected}
          edges={data.edges.filter((e) => e.source === selected.id || e.target === selected.id)}
          allNodes={data.nodes}
          onClose={() => setSelected(null)}
          onNavigate={(itemKey, page) => {
            onPaperNavigate?.(itemKey, page);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function NodeDetail({
  node,
  edges,
  allNodes,
  onClose,
  onNavigate,
}: {
  node: GraphNode;
  edges: GraphEdge[];
  allNodes: GraphNode[];
  onClose: () => void;
  onNavigate: (itemKey: string, page?: number) => void;
}) {
  const related = edges.map((e) => {
    const otherId = e.source === node.id ? e.target : e.source;
    const other = allNodes.find((n) => n.id === otherId);
    const direction = e.source === node.id ? "out" : "in";
    return { edge: e, other, direction };
  });

  const paper = node.itemKey ? getItem(node.itemKey) : null;

  return (
    <div class="node-detail">
      <div class="node-detail-head">
        <div>
          <div class="node-detail-type" style={{ color: TYPE_COLORS[node.type] }}>
            {TYPE_LABELS[node.type]}
          </div>
          <b>{node.label}</b>
        </div>
        <button class="icon-btn" onClick={onClose} title="关闭">
          ×
        </button>
      </div>
      {node.description && <div class="node-detail-desc">{node.description}</div>}
      {paper && (
        <div class="node-detail-paper">
          <div class="muted small">对应文献</div>
          <div>{paperTitle(paper)}</div>
          {node.pages && node.pages.length > 0 && (
            <button class="chip primary" onClick={() => onNavigate(node.itemKey!, node.pages![0])}>
              定位到原文 p.{node.pages![0]}
            </button>
          )}
        </div>
      )}
      {related.length > 0 && (
        <div class="node-detail-edges">
          <div class="muted small">关联关系 ({related.length})</div>
          {related.map(({ edge, other, direction }, i) => (
            <div key={i} class="edge-row">
              <span class="edge-label">{direction === "out" ? EDGE_LABELS[edge.type] : "被" + EDGE_LABELS[edge.type]}</span>
              {other && (
                <span
                  class="edge-node"
                  style={{ color: TYPE_COLORS[other.type] }}
                  onClick={() => other.itemKey && onNavigate(other.itemKey, edge.page)}
                >
                  {other.label}
                  {edge.page && <span class="page-ref">p.{edge.page}</span>}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// d3-drag is not exported from d3-force, so we import it separately
import { drag as d3Drag } from "d3-drag";
