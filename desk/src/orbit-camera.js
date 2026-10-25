// orbit-camera.js — 球面轨道相机 + 阻尼（无依赖）
//
// 要点：
// 1) 角度/距离各有"目标值"和"当前值"，每帧向目标做指数逼近：
//    k = 1 - exp(-λ·dt)  → 与帧率无关（固定每毫秒的收敛比例），不要写 x += (t-x)*0.1
// 2) 指针用 Pointer Events + setPointerCapture：鼠标/触屏/触控笔一套代码
// 3) 滚轮必须 addEventListener('wheel', fn, { passive:false }) 才能 preventDefault，
//    否则浏览器把滚动交给页面（默认 passive:true 会报 "Unable to preventDefault"）
// 4) canvas 上要 CSS touch-action: none，否则触屏拖动会同时滚动页面
// 5) phi 夹住避免翻到桌面下方/穿过极点；俯仰接近极点时方位角会疯狂旋转

export class OrbitCamera {
  constructor({
    target = [0, 0, 0],
    distance = 1050,
    theta = 0.6,          // 方位角（弧度）
    phi = 1.05,           // 极角：PI/2 是水平，越小越俯视
    minDistance = 380,
    maxDistance = 2600,
    minPhi = 0.12,
    maxPhi = Math.PI / 2 - 0.02,
    damping = 11,         // 越大越"紧跟"，越小越飘
    rotateSpeed = 0.0055,
    zoomSpeed = 0.0015,
    panSpeed = 0.9,
  } = {}) {
    this.target = target.slice();
    this.targetGoal = target.slice();
    this.theta = theta; this.phi = phi; this.distance = distance;
    this.thetaGoal = theta; this.phiGoal = phi; this.distanceGoal = distance;
    this.minDistance = minDistance; this.maxDistance = maxDistance;
    this.minPhi = minPhi; this.maxPhi = maxPhi;
    this.damping = damping; this.rotateSpeed = rotateSpeed;
    this.zoomSpeed = zoomSpeed; this.panSpeed = panSpeed;
    this.eye = [0, 0, 0];
    this._pointers = new Map();
    this._lastPinch = 0;
    this._dragging = false;
    this.enabled = true;
  }

  attach(el) {
    const pointers = this._pointers;
    const onDown = (e) => {
      if (!this.enabled) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      el.setPointerCapture?.(e.pointerId);
      this._dragging = true;
      el.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pointers.size === 1) {
        if (p.button === 2 || p.shift || e.shiftKey) {
          // 平移：沿相机自身右/上方向移动焦点
          this.panBy(dx, dy);
        } else {
          this.thetaGoal -= dx * this.rotateSpeed;
          this.phiGoal = Math.min(this.maxPhi, Math.max(this.minPhi, this.phiGoal - dy * this.rotateSpeed));
        }
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this._lastPinch > 0) this.zoomBy(this._lastPinch / d);
        this._lastPinch = d;
      }
    };
    const onUp = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) this._lastPinch = 0;
      if (pointers.size === 0) { this._dragging = false; el.style.cursor = 'grab'; }
    };
    const onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();   // 关键：需要 { passive: false }
      const k = Math.exp(e.deltaY * this.zoomSpeed);
      this.distanceGoal = Math.min(this.maxDistance, Math.max(this.minDistance, this.distanceGoal * k));
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.style.touchAction = 'none';       // 触屏拖拽不滚动页面
    el.style.cursor = 'grab';
    this._detach = () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
    };
  }

  panBy(dxPx, dyPx) {
    // 屏幕像素 → 世界距离（按距离线性缩放，近似正交/透视都够用）
    const s = this.distance * 0.0016 * this.panSpeed;
    const ct = Math.cos(this.theta), st = Math.sin(this.theta);
    // 相机右向量（水平面内）与近似上向量
    this.targetGoal[0] -= (ct * dxPx) * s;
    this.targetGoal[2] += (st * dxPx) * s;
    this.targetGoal[1] += dyPx * s;
  }

  zoomBy(factor) {
    this.distanceGoal = Math.min(this.maxDistance, Math.max(this.minDistance, this.distanceGoal * factor));
  }

  /** dt 单位秒。指数逼近 → 帧率无关 */
  update(dt) {
    const k = 1 - Math.exp(-this.damping * Math.min(dt, 0.1));
    this.theta += (this.thetaGoal - this.theta) * k;
    this.phi += (this.phiGoal - this.phi) * k;
    this.distance += (this.distanceGoal - this.distance) * k;
    for (let i = 0; i < 3; i++) this.target[i] += (this.targetGoal[i] - this.target[i]) * k;
    const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
    this.eye[0] = this.target[0] + this.distance * sp * Math.sin(this.theta);
    this.eye[1] = this.target[1] + this.distance * cp;
    this.eye[2] = this.target[2] + this.distance * sp * Math.cos(this.theta);
    return this;
  }
}

/* ---------------- 极小 mat4（列主序，和 GL 一致）---------------- */
export const mat4 = {
  identity() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
  perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[11] = -1;
    out[12] = 0; out[13] = 0; out[15] = 0;
    out[10] = (far + near) / (near - far);
    out[14] = (2 * far * near) / (near - far);
    return out;
  },
  lookAt(out, eye, center, up) {
    let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
    let l = Math.hypot(z0, z1, z2) || 1; z0 /= l; z1 /= l; z2 /= l;
    let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
    l = Math.hypot(x0, x1, x2);
    if (l === 0) { x0 = 1; x1 = 0; x2 = 0; } else { x0 /= l; x1 /= l; x2 /= l; }
    const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
    out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    out[15] = 1;
    return out;
  },
  multiply(out, a, b) { // out = a * b（列主序）
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  },
};