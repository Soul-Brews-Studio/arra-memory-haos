import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { api } from "./api";
import { kindColor } from "./Chips";
import { Panel } from "./Menu";
import { t } from "./i18n";
import type { Graph, GraphNode, Scope } from "./types";

/**
 * The corpus, drawn.
 *
 * Two modes, and the difference between them is the whole point:
 *
 *   MAP — points only, positioned by projecting each memory's embedding to three
 *         dimensions. Proximity IS similarity. No edges, so nothing occludes
 *         anything and it stays readable at any size.
 *
 *   WEB — the same points plus edges to near neighbours. More striking, and
 *         legible only while the corpus is small. Obsidian's graph is unreadable
 *         past ~200 notes; Roam's layout gives up around 600. That is not a
 *         layout problem with a layout fix — it is what node-link diagrams do.
 *
 * The header states the density, which is the honest signal for which mode to
 * trust: near 100% every pair is an edge and the web is a hairball whatever it
 * looks like. It also states the variance the projection captured, because three
 * axes out of 1024 is a shadow and a viewer is owed that.
 *
 * ── rendering
 *
 * One `Points` for every node and one `LineSegments` for every edge — two draw
 * calls total, regardless of corpus size. The obvious alternative (a Mesh per
 * node, a Line per edge) is what the popular graph libraries do and it puts the
 * draw-call count in the thousands, where CPU command submission, not the GPU,
 * becomes the limit at around 500.
 */

type Mode = "map" | "web";

export function Atlas({
  onClose,
  nav,
  scope,
  onOpenMemory,
}: {
  onClose: () => void;
  nav?: React.ReactNode;
  /** The chip filters, so the drawing shows what the archive is showing. */
  scope: Scope;
  onOpenMemory: (id: string) => void;
}) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [mode, setMode] = useState<Mode>("map");
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mount = useRef<HTMLDivElement>(null);

  const scopeKey = useMemo(
    () => JSON.stringify([scope.kind, scope.workspace, scope.project, scope.createdBy]),
    [scope],
  );

  useEffect(() => {
    let live = true;
    api.graph(scope)
      .then((g) => live && (setGraph(g), setError(null)))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not build the graph."));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    const host = mount.current;
    if (!host || !graph || graph.nodes.length === 0) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 4);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    // ── nodes: one Points, one draw call
    const positions = new Float32Array(graph.nodes.length * 3);
    const colors = new Float32Array(graph.nodes.length * 3);
    const sizes = new Float32Array(graph.nodes.length);
    const probe = document.createElement("span");
    host.appendChild(probe);
    graph.nodes.forEach((node, i) => {
      positions[i * 3] = node.x * 1.6;
      positions[i * 3 + 1] = node.y * 1.6;
      positions[i * 3 + 2] = node.z * 1.6;
      // kindColor returns a CSS variable for known kinds, so it has to be
      // resolved against the document rather than parsed as a hex string —
      // otherwise every node renders black under a theme it cannot read.
      probe.style.color = kindColor(node.kind);
      const rgb = getComputedStyle(probe).color;
      const c = new THREE.Color(rgb);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      // WORLD units, not pixels — the shader multiplies by a projection scale
      // and divides by depth, so a pixel value here becomes a point thousands
      // of pixels across at any sane camera distance. Importance is the one
      // property worth encoding in size: it is the only field a human chose.
      sizes[i] = 0.04 + node.importance * 0.012;
    });
    host.removeChild(probe);

    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    nodeGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    nodeGeo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const nodeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 1 } },
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        uniform float uScale;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          // Round sprites, soft edge. Discarding outside the circle keeps the
          // points from reading as squares when they overlap.
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d);
          if (r > 0.5) discard;
          gl_FragColor = vec4(vColor, smoothstep(0.5, 0.28, r));
        }`,
      vertexColors: true,
    });
    const points = new THREE.Points(nodeGeo, nodeMat);
    scene.add(points);

    // ── edges: one LineSegments, one draw call
    let lines: THREE.LineSegments | null = null;
    if (mode === "web" && graph.edges.length) {
      // The theme's accent, resolved through the document because it is a CSS
      // custom property — the same reason node colours need a probe element.
      const accentProbe = document.createElement("span");
      accentProbe.style.color = "var(--color-ember)";
      host.appendChild(accentProbe);
      const accent = new THREE.Color(getComputedStyle(accentProbe).color);
      host.removeChild(accentProbe);

      const linePos = new Float32Array(graph.edges.length * 6);
      const lineCol = new Float32Array(graph.edges.length * 6);
      graph.edges.forEach((edge, i) => {
        const a = graph.nodes[edge.source]!;
        const b = graph.nodes[edge.target]!;
        linePos.set([a.x * 1.6, a.y * 1.6, a.z * 1.6, b.x * 1.6, b.y * 1.6, b.z * 1.6], i * 6);
        // Three kinds, three treatments, because they are three different
        // claims. A written [[link]] is someone saying these belong together —
        // it gets the accent colour and full strength. An inferred neighbour is
        // a statistic, drawn grey and brighter the nearer the pair. A bridge
        // exists only so the graph stays connected and is faintest of all, so
        // it cannot be mistaken for a closeness it does not carry.
        if (edge.kind === "link") {
          for (let v = 0; v < 2; v++) {
            lineCol.set([accent.r, accent.g, accent.b], i * 6 + v * 3);
          }
        } else {
          const strength =
            edge.kind === "bridge" ? 0.12 : Math.max(0.1, 1 - edge.distance) * 0.75;
          for (let v = 0; v < 2; v++) lineCol.set([strength, strength, strength], i * 6 + v * 3);
        }
      });
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
      lineGeo.setAttribute("color", new THREE.BufferAttribute(lineCol, 3));
      lines = new THREE.LineSegments(
        lineGeo,
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 }),
      );
      scene.add(lines);
    }

    // ── interaction: drag to rotate, wheel to zoom, hover to identify
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.09 };
    const pointer = new THREE.Vector2();
    const rot = { x: 0.2, y: 0.5 };
    let drag: { x: number; y: number } | null = null;
    let dist = 4;
    let spin = true;

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      // The buffer is sized in JS; the DISPLAY size is pinned in CSS below, once.
      //
      // Not left to three's updateStyle: measured here, the canvas came back
      // with `display: block; touch-action: none` and no width or height at all,
      // so it fell back to rendering at its intrinsic buffer size — 1708 CSS px
      // inside an 854px container, cropped to a corner by overflow-hidden. Every
      // point then looked enormous because we were seeing a fraction of a frame,
      // not because anything was sized wrong. Pinning width/height to 100% makes
      // the display size the container's business and the buffer size ours,
      // which is the split that cannot drift.
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // The perspective scale that converts a world-space radius to pixels:
      // viewportHeight / (2 · tan(fov/2)). Deriving it from the camera rather
      // than guessing is what keeps a point the same apparent size when the
      // panel is resized.
      // gl_PointSize is in DEVICE pixels, so the pixel ratio belongs in the
      // scale — without it every point renders at half size on a retina panel
      // and the map reads as empty.
      nodeMat.uniforms.uScale!.value =
        (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const onDown = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY }; spin = false; };
    const onUp = () => { drag = null; };
    const onMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      if (!drag) return;
      rot.y += (e.clientX - drag.x) * 0.006;
      rot.x += (e.clientY - drag.y) * 0.006;
      rot.x = Math.max(-1.4, Math.min(1.4, rot.x));
      drag = { x: e.clientX, y: e.clientY };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      dist = Math.max(1.4, Math.min(12, dist + e.deltaY * 0.003));
    };
    const onClick = () => {
      const hit = raycaster.intersectObject(points)[0];
      if (hit?.index !== undefined) onOpenMemory(graph.nodes[hit.index]!.id);
    };

    const el = renderer.domElement;
    el.style.touchAction = "none";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.display = "block";
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("click", onClick);

    let raf = 0;
    let lastHover = -1;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      // A slow drift until the first interaction, so the shape reads as
      // three-dimensional without anyone having to discover that it turns.
      if (spin && !reduce) rot.y += 0.0016;
      camera.position.set(
        Math.sin(rot.y) * Math.cos(rot.x) * dist,
        Math.sin(rot.x) * dist,
        Math.cos(rot.y) * Math.cos(rot.x) * dist,
      );
      camera.lookAt(0, 0, 0);

      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(points)[0];
      const idx = hit?.index ?? -1;
      if (idx !== lastHover) {
        lastHover = idx;
        setHovered(idx >= 0 ? graph.nodes[idx]! : null);
        el.style.cursor = idx >= 0 ? "pointer" : "grab";
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("click", onClick);
      // WebGL contexts are a finite browser resource — a few dozen leaked and
      // the page stops being able to make new ones.
      nodeGeo.dispose();
      nodeMat.dispose();
      lines?.geometry.dispose();
      (lines?.material as THREE.Material | undefined)?.dispose();
      renderer.dispose();
      if (el.parentNode === host) host.removeChild(el);
    };
  }, [graph, mode, onOpenMemory]);

  const dense = (graph?.density ?? 0) > 0.5;

  return (
    <Panel
      eyebrow={t("nav.atlas")}
      title={t("atlas.title")}
      subtitle={t("atlas.subtitle")}
      onClose={onClose}
      nav={nav}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {(["map", "web"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              className="chip"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {t(m === "map" ? "atlas.map" : "atlas.web")}
            </button>
          ))}
          {graph && (
            <span className="meta ml-2">
              {graph.nodes.length} · {graph.k ? `k=${graph.k}` : "—"} ·{" "}
              {t("atlas.explained")} {Math.round(graph.explained * 100)}%
              {mode === "web" && ` · ${t("atlas.density")} ${Math.round(graph.density * 100)}%`}
              {graph.unembedded > 0 && ` · ${graph.unembedded} ${t("atlas.unembedded")}`}
            </span>
          )}
        </div>
      }
    >
      {error && (
        <p role="alert" className="mb-3 rounded-lg border border-line px-3 py-2 text-sm text-[#f0928f]">
          {error}
        </p>
      )}

      {/* Said out loud rather than left for the viewer to misread as structure.
          A complete graph looks like a rich network and means the opposite. */}
      {mode === "web" && dense && (
        <p className="meta mb-3 rounded-lg border border-dashed border-line px-3 py-2">
          {t("atlas.denseWarning")}
        </p>
      )}

      {graph && graph.nodes.length === 0 ? (
        <p className="py-16 text-center text-sm text-dim">{t("atlas.empty")}</p>
      ) : (
        <div className="relative">
          {/* Fixed aspect rather than a viewport height: this sits inside a Home
              Assistant ingress iframe whose height is not ours to assume. */}
          <div
            ref={mount}
            className="w-full overflow-hidden rounded-xl border border-line bg-panel"
            style={{ aspectRatio: "16 / 10" }}
          />
          {hovered && (
            <div className="pointer-events-none absolute left-3 top-3 max-w-sm rounded-lg border border-line bg-ground/95 px-3 py-2">
              <p className="text-sm text-ink">{hovered.title}</p>
              <p className="meta mt-1">
                {[hovered.kind, hovered.workspace, hovered.project, hovered.createdBy]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
