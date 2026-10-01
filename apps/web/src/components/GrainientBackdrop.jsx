import { useEffect, useRef, useState } from "react";

// One low-resolution WebGL surface per page shell (below the hero on Home).
// The soft moving color field is adapted from React Bits' Grainient idea; the
// source shader's vivid palette, grain animation, and many controls are omitted.
const vertexSource = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

const fragmentSource = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float wave = sin(uv.y * 7.2 - uTime * 0.52 + sin(uv.x * 4.2 + uTime * 0.25) * 0.7) * 0.12;
  float flow = 0.5 + 0.5 * sin((uv.y + wave) * 8.4 - uTime * 0.58 + uv.x * 2.6);
  float blue = clamp(0.22 + flow * 0.6 + smoothstep(0.05, 0.95, uv.x + wave) * 0.12, 0.2, 0.92);
  vec3 white = vec3(0.991, 0.994, 0.991);
  vec3 paleBlue = vec3(0.55, 0.8, 0.945);
  vec3 cream = vec3(0.972, 0.935, 0.873);
  vec3 color = mix(white, paleBlue, blue);
  float warm = exp(-dot((uv - vec2(0.83, 0.63)) * vec2(2.4, 3.1),
                        (uv - vec2(0.83, 0.63)) * vec2(2.4, 3.1)));
  color = mix(color, cream, warm * 0.13);
  float grain = fract(sin(dot(uv * uResolution, vec2(12.9898, 78.233))) * 43758.5453);
  color += (grain - 0.5) * 0.007;
  fragColor = vec4(color, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || "Unable to compile shader");
  }
  return shader;
}

export default function GrainientBackdrop() {
  const host = useRef(null);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const previewFallback = import.meta.env.DEV && new URLSearchParams(window.location.search).get("grain") === "off";
    if (reducedMotion || previewFallback || !host.current) return;
    const container = host.current;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    let gl;
    try {
      gl = canvas.getContext("webgl2", { alpha: false, antialias: false, powerPreference: "low-power" });
    } catch { return; }
    if (!gl) return; // The CSS background remains visible.

    let program;
    let buffer;
    let raf = 0;
    let visible = false;
    let lastFrame = 0;
    let elapsed = 0;
    let failed = false;

    try {
      const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
      const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      gl.useProgram(program);
      const position = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      container.appendChild(canvas);
      container.dataset.renderer = "webgl";
    } catch {
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      return;
    }

    const resolution = gl.getUniformLocation(program, "uResolution");
    const time = gl.getUniformLocation(program, "uTime");

    function draw() {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function size() {
      if (failed) return;
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.min(1280, Math.round(rect.width * dpr)));
      canvas.height = Math.max(1, Math.min(1200, Math.round(rect.height * dpr)));
      draw();
    }

    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; lastFrame = 0; }
    function tick(now) {
      raf = requestAnimationFrame(tick);
      if (now - lastFrame < 1000 / 24) return;
      if (lastFrame) elapsed += Math.min((now - lastFrame) / 1000, 0.08);
      lastFrame = now;
      draw();
    }
    function update() {
      if (!failed && visible && !document.hidden && !raf) raf = requestAnimationFrame(tick);
      if (failed || !visible || document.hidden) stop();
      container.dataset.animation = raf ? "running" : "paused";
    }
    function contextLost(event) {
      event.preventDefault();
      failed = true;
      stop();
      canvas.style.display = "none";
      container.dataset.renderer = "fallback";
      container.dataset.animation = "paused";
    }

    const resize = new ResizeObserver(size);
    resize.observe(container);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    intersection.observe(container);
    document.addEventListener("visibilitychange", update);
    canvas.addEventListener("webglcontextlost", contextLost);
    size();

    return () => {
      stop();
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", update);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.remove();
      delete container.dataset.renderer;
      delete container.dataset.animation;
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [reducedMotion]);

  return <div ref={host} className="grainient-backdrop" aria-hidden="true" />;
}
