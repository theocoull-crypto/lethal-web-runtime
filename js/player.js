// First-person player: capsule controller, sprint/stamina, crouch, jump, fall damage, interaction ray.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3(), _v = new THREE.Vector3(), _start = new THREE.Vector3(), _end = new THREE.Vector3();

export class Player {
  constructor(game) {
    this.game = game;
    this.camera = game.camera;
    this.pos = new THREE.Vector3(0, 5, 0);   // feet position
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.radius = 0.5;
    this.standHeight = 2.5; this.crouchHeight = 1.6;
    this.height = this.standHeight;
    this.eyeOffset = -0.35;
    this.speed = 4.6; this.sprintMul = 2.25; this.crouchMul = 0.5;
    this.stamina = 1; this.sprinting = false; this.crouching = false; this.onGround = false;
    this.health = 100; this.dead = false;
    this.carryWeight = 0;
    this.fallSpeed = 0; this.airTime = 0;
    this.keys = {}; this.mouse = { dx: 0, dy: 0 };
    // Google Apps Script serves pages inside a sandbox that does not grant Pointer Lock.
    // The hosted game adds ?embed=1 there, so keep controls usable with ordinary mouse
    // movement and the arrow keys while leaving normal browser play unchanged.
    this.embedded = window.LETHAL_WEB_EMBEDDED === true || new URLSearchParams(location.search).get('embed') === '1';
    this.bob = 0; this.bobAmp = 0;
    this.stepTimer = 0;
    this.locked = false;
    this.inputEnabled = true;
    this.lookSensitivity = 0.0022;
    this.holdCrouch = false;
    this.attached = null; // Object3D we stand on (ship) -> follow its motion
    this.lastAttachedMatrix = new THREE.Matrix4();
    this.groundNormalUp = 1;
    this._bind();
  }

  _bind() {
    const c = this.game.renderer.domElement;
    addEventListener('keydown', e => {
      if (e.code === 'Tab' || e.code === 'F5' || e.code === 'F12') return;
      this.keys[e.code] = true;
      if (this.embedded && e.code === 'Escape' && this.game.state === 'play' && this.game.settings) { this.game.settings.toggle(); e.preventDefault(); return; }
      if (this.locked && this.inputEnabled) { this.game.onKey(e.code, true); if (['Space', 'KeyE', 'KeyG', 'KeyF', 'KeyQ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault(); }
    });
    addEventListener('keyup', e => { this.keys[e.code] = false; this.game.onKey(e.code, false); });
    addEventListener('blur', () => { this.keys = {}; });
    addEventListener('mousemove', e => {
      if (!this.locked || (!this.embedded && document.pointerLockElement !== c)) return;
      this.mouse.dx += e.movementX; this.mouse.dy += e.movementY;
    });
    addEventListener('mousedown', e => { if (this.locked && this.inputEnabled) this.game.onMouse(e.button, true); });
    addEventListener('mouseup', e => { if (this.locked) this.game.onMouse(e.button, false); });
    addEventListener('wheel', e => { if (this.locked) this.game.onWheel(Math.sign(e.deltaY)); }, { passive: true });
    document.addEventListener('pointerlockchange', () => { if (this.embedded) return; this.locked = document.pointerLockElement === c; this.game.onLockChange(this.locked); });
    c.addEventListener('click', () => {
      if (this.embedded) { if (!this.locked && this.game.wantsLock) this.lock(); c.focus(); return; }
      if (!this.locked && this.game.wantsLock) { try { const r = c.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) { } }
    });
  }

  lock() {
    this.game.wantsLock = true;
    if (this.embedded) {
      this.locked = true;
      this.game.renderer.domElement.style.cursor = 'none';
      this.game.renderer.domElement.focus(); this.game.onLockChange(true); return;
    }
    try { const r = this.game.renderer.domElement.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) { }
  }

  unlock() {
    if (this.embedded) {
      if (!this.locked) return;
      this.locked = false; this.mouse.dx = this.mouse.dy = 0;
      this.game.renderer.domElement.style.cursor = 'auto';
      this.game.onLockChange(false); return;
    }
    document.exitPointerLock();
  }

  _updateLook(dt) {
    const k = this.keys;
    if (this.locked && this.inputEnabled) {
      this.yaw -= this.mouse.dx * this.lookSensitivity;
      this.pitch -= this.mouse.dy * this.lookSensitivity;
      if (this.embedded) {
        const keyLook = 1.8 * dt;
        if (k.ArrowLeft) this.yaw += keyLook; if (k.ArrowRight) this.yaw -= keyLook;
        if (k.ArrowUp) this.pitch += keyLook; if (k.ArrowDown) this.pitch -= keyLook;
      }
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    }
    this.mouse.dx = this.mouse.dy = 0;
  }

  get eyeHeight() { return this.height + this.eyeOffset; }
  get eye() { return _v.copy(this.pos).add(new THREE.Vector3(0, this.eyeHeight, 0)); }

  teleport(p, yaw) { this.pos.copy(p); this.vel.set(0, 0, 0); if (yaw != null) this.yaw = yaw; this.fallSpeed = 0; this.resyncAttach(); }

  // re-snapshot the attached object's pose: call after teleporting or after the ship was moved while the player was not updating
  resyncAttach() { if (this.attached) { this.attached.updateMatrixWorld(); this.lastAttachedMatrix.copy(this.attached.matrixWorld); } }

  forward(out) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  right(out) { return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  startLadder(ld) {
    if (this.ladder) return;
    this.ladder = ld; this.vel.set(0, 0, 0); this.attachTo(null);
    // snap onto the ladder line at the current height
    const y = THREE.MathUtils.clamp(this.pos.y, Math.min(ld.topPos.y, ld.bottomPos.y), Math.max(ld.topPos.y, ld.bottomPos.y));
    this.pos.set(ld.lineX, y, ld.lineZ);
    this.game.onLadder(true);
  }

  stopLadder(atTop) {
    const ld = this.ladder; if (!ld) return;
    this.ladder = null;
    if (atTop) { const f = new THREE.Vector3(ld.topPos.x - ld.lineX, 0, ld.topPos.z - ld.lineZ); if (f.lengthSq() < 0.01) this.forward(f); f.normalize(); this.pos.copy(ld.topPos).addScaledVector(f, 0.6); this.pos.y = ld.topPos.y + 0.1; }
    this.game.onLadder(false);
  }

  _updateLadder(dt) {
    const k = this.keys, ld = this.ladder;
    this._updateLook(dt);
    const up = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0);
    const top = Math.max(ld.topPos.y, ld.bottomPos.y), bottom = Math.min(ld.topPos.y, ld.bottomPos.y);
    this.pos.y += up * 3 * dt;
    if (up !== 0) { this.stepTimer -= dt * 1.2; if (this.stepTimer <= 0) { this.stepTimer = 0.5; this.game.onLadderStep(); } }
    if (this.pos.y >= top - 0.05 && up > 0) { this.stopLadder(true); return; }
    if (this.pos.y <= bottom + 0.02 && up < 0) { this.pos.y = bottom; this.stopLadder(false); return; }
    if (k.Space || k.KeyE && this._ladderExitOk) { this.stopLadder(false); return; }
    const eye = this.pos.clone(); eye.y += this.eyeHeight;
    this.camera.position.copy(eye);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  _updateNoclip(dt) {
    const k = this.keys;
    this._updateLook(dt);
    const sp = (k.ShiftLeft ? 30 : 10) * dt;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion), r = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    if (k.KeyW) this.pos.addScaledVector(f, sp); if (k.KeyS) this.pos.addScaledVector(f, -sp);
    if (k.KeyD) this.pos.addScaledVector(r, sp); if (k.KeyA) this.pos.addScaledVector(r, -sp);
    if (k.Space) this.pos.y += sp; if (k.ControlLeft || k.KeyC) this.pos.y -= sp;
    this.vel.set(0, 0, 0); this.onGround = true; this.attached = null;
    const eye = this.pos.clone(); eye.y += this.eyeHeight;
    this.camera.position.copy(eye);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  update(dt, colliders) {
    if (this.noclip) { this._updateNoclip(dt); return; }
    if (this.ladder) { this._updateLadder(dt); return; }
    const k = this.keys;
    this._updateLook(dt);
    const move = new THREE.Vector3();
    let wantSprint = false, wantCrouch = false, wantJump = false;
    if (this.locked && this.inputEnabled && !this.dead) {
      if (k.KeyW) move.z -= 1; if (k.KeyS) move.z += 1; if (k.KeyA) move.x -= 1; if (k.KeyD) move.x += 1;
      wantSprint = !!k.ShiftLeft && move.z < 0 && !this.crouching;
      wantCrouch = !!(k.ControlLeft || k.KeyC);
      wantJump = !!k.Space;
    }
    // crouch (can't stand up if blocked -> ignore, simple)
    this.crouching = wantCrouch;
    const targetH = this.crouching ? this.crouchHeight : this.standHeight;
    this.height += (targetH - this.height) * Math.min(1, dt * 12);
    // stamina
    const weightPenalty = 1 + this.carryWeight / 105;
    if (wantSprint && this.stamina > 0.02) { this.sprinting = true; if (!this.infStamina) this.stamina = Math.max(0, this.stamina - dt / 11 * weightPenalty); }
    else { this.sprinting = false; this.stamina = Math.min(1, this.stamina + dt / (move.lengthSq() > 0 ? 22 : 12)); }
    if (this.stamina <= 0.02) this.sprinting = false;
    let sp = this.speed * (this.sprinting ? this.sprintMul : 1) * (this.crouching ? this.crouchMul : 1);
    sp /= (1 + this.carryWeight / 105);
    if (this.slowT > 0) { this.slowT -= dt; sp *= 0.35; }   // caught in a bunker spider web
    if (move.lengthSq() > 0) {
      move.normalize();
      const f = this.forward(new THREE.Vector3()), r = this.right(new THREE.Vector3());
      _dir.set(0, 0, 0).addScaledVector(f, -move.z).addScaledVector(r, move.x);
      const accel = this.onGround ? 40 : 8;
      this.vel.x += (_dir.x * sp - this.vel.x) * Math.min(1, accel * dt);
      this.vel.z += (_dir.z * sp - this.vel.z) * Math.min(1, accel * dt);
    } else {
      const damp = this.onGround ? Math.min(1, 25 * dt) : Math.min(1, 1.5 * dt);
      this.vel.x -= this.vel.x * damp; this.vel.z -= this.vel.z * damp;
    }
    // gravity / jump
    if (this.onGround && wantJump && !this.crouching && this.jumpCooldown <= 0) { this.vel.y = 9.5; this.onGround = false; this.jumpCooldown = 0.35; this.game.onJump(); }
    this.jumpCooldown = (this.jumpCooldown || 0) - dt;
    this.vel.y -= 30 * dt;
    if (this.vel.y < -55) this.vel.y = -55;
    // follow moving platform (ship)
    if (this.attached) {
      this.attached.updateMatrixWorld();
      const cur = this.attached.matrixWorld;
      const delta = new THREE.Matrix4().multiplyMatrices(cur, this.lastAttachedMatrix.clone().invert());
      this.pos.applyMatrix4(delta);
      this.lastAttachedMatrix.copy(cur);
    }
    // integrate in substeps to avoid tunnelling
    const steps = Math.max(1, Math.ceil(this.vel.length() * dt / 0.4));
    const sdt = dt / steps;
    let grounded = false; let hitInfo = { maxUp: -1, minUp: 1, groundCollider: null };
    let landedSpeed = 0; let groundCollider = null;
    for (let i = 0; i < steps; i++) {
      this.pos.addScaledVector(this.vel, sdt);
      // capsule segment: from feet+radius to top-radius
      const h = Math.max(this.height, this.radius * 2 + 0.05);
      _start.copy(this.pos).y += this.radius;
      _end.copy(this.pos).y += h - this.radius;
      hitInfo = { maxUp: -1, minUp: 1, groundCollider: null };
      let any = false;
      for (let iter = 0; iter < 3; iter++) {
        let hit = false;
        for (const c of colliders) { if (c.resolveCapsule(_start, _end, this.radius, hitInfo)) hit = true; }
        if (!hit) break; any = true;
      }
      if (any) {
        const before = this.pos.y;
        this.pos.set(_start.x, _start.y - this.radius, _start.z);
        if (hitInfo.maxUp > 0.5) {
          if (this.vel.y < -0.5) landedSpeed = Math.min(landedSpeed, this.vel.y);
          grounded = true; groundCollider = hitInfo.groundCollider;
          if (this.vel.y < 0) this.vel.y = 0;
        } else if (hitInfo.minUp < -0.5 && this.vel.y > 0) {
          this.vel.y = 0; // head bump
        } else if (hitInfo.maxUp > -0.5 && hitInfo.maxUp <= 0.5 && this.onGround && this.vel.y <= 0) {
          // sliding along a wall; slight upward slope handled by capsule roundness
        }
        // cancel velocity into walls
        if (hitInfo.maxUp <= 0.5) {
          const pushed = new THREE.Vector3(_start.x, 0, _start.z).sub(new THREE.Vector3(this.pos.x, 0, this.pos.z));
        }
      }
    }
    // ground probe (small downward ray) keeps us glued on slopes/stairs
    if (!grounded && this.vel.y <= 0) {
      const probe = new THREE.Vector3(0, -1, 0);
      const origin = this.pos.clone(); origin.y += this.radius + 0.05;
      for (const c of colliders) {
        const hit = c.raycast(origin, probe, this.radius + 0.35);
        if (hit && hit.face && hit.face.normal.y > 0.5) {
          this.pos.y = hit.point.y; grounded = true; groundCollider = c; if (this.vel.y < 0) { landedSpeed = Math.min(landedSpeed, this.vel.y); this.vel.y = 0; } break;
        }
      }
    }
    const wasGround = this.onGround;
    this.onGround = grounded;
    this.groundCollider = grounded ? groundCollider : null;
    if (grounded) { this.airTime = 0; } else this.airTime += dt;
    if (grounded && !wasGround && landedSpeed < -16 && !this.riding) {
      const dmg = Math.min(100, Math.round((-landedSpeed - 16) * 6));
      if (dmg > 0) this.damage(dmg, 'fall');
      this.game.onLand(landedSpeed);
    } else if (grounded && !wasGround && landedSpeed < -6) this.game.onLand(landedSpeed);
    if (this.pos.y < -300) { this.damage(1000, 'void'); }
    // head bob
    const moving = grounded && this.vel.lengthSq() > 1;
    const targetAmp = moving ? (this.sprinting ? 0.09 : 0.045) : 0;
    this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 8);
    if (moving) { this.bob += dt * (this.sprinting ? 13 : 9); }
    // footsteps
    if (moving) {
      this.stepTimer -= dt * (this.sprinting ? 2.1 : this.crouching ? 0.7 : 1.35);
      if (this.stepTimer <= 0) { this.stepTimer = 0.5; this.game.onFootstep(); }
    } else this.stepTimer = Math.min(this.stepTimer, 0.15);
    // camera
    const eye = this.pos.clone(); eye.y += this.eyeHeight + Math.sin(this.bob * 2) * this.bobAmp;
    eye.x += Math.sin(this.bob) * this.bobAmp * 0.5; eye.z += Math.cos(this.bob) * this.bobAmp * 0.5;
    this.camera.position.copy(eye);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, Math.sin(this.bob) * this.bobAmp * 0.15, 'YXZ'));
  }

  attachTo(obj) {
    if (this.attached === obj) return;
    this.attached = obj;
    if (obj) { obj.updateMatrixWorld(); this.lastAttachedMatrix.copy(obj.matrixWorld); }
  }

  damage(amount, source) {
    if (this.dead || this.god) return;
    this.health = Math.max(0, this.health - amount);
    this.game.onDamage(amount, source);
    if (this.health <= 0) this.die(source);
  }

  die(source) {
    if (this.dead) return;
    this.dead = true;
    this.game.onDeath(source);
  }

  heal(dt) {
    if (!this.dead && this.health < 100 && this.health > 20) this.health = Math.min(100, this.health + dt * 2.5);
  }
}
