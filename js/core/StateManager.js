/* GRIMALKIN 1010 — StateManager: the global game-state machine.
 *
 *   BOOT ─► ATTRACT ─► MINING ◄─► AWAKE
 *              ▲          │          │
 *              └──── GAMEOVER ◄──────┘
 */

class StateManager {
    constructor() {
        this.current = StateManager.BOOT;
        this.previous = null;
        this.timeInState = 0;
        this.listeners = [];
        this.history = [StateManager.BOOT];
    }

    /** Is `to` a legal transition from the current state? */
    canEnter(to) {
        const allowed = StateManager.TRANSITIONS[this.current];
        return !!allowed && allowed.indexOf(to) >= 0;
    }

    /** Transition. Illegal transitions are refused (returns false) rather than thrown. */
    set(to) {
        if (to === this.current) return true;
        if (!this.canEnter(to)) return false;
        this.previous = this.current;
        this.current = to;
        this.timeInState = 0;
        this.history.push(to);
        if (this.history.length > 32) this.history.shift();
        for (let i = 0; i < this.listeners.length; i++) {
            try { this.listeners[i](to, this.previous); } catch (e) { /* listener errors never break the loop */ }
        }
        return true;
    }

    is(state) { return this.current === state; }

    /** True while a round is being played (player has control). */
    get inPlay() {
        return this.current === StateManager.MINING || this.current === StateManager.AWAKE;
    }

    onChange(fn) { this.listeners.push(fn); }

    update(dt) { this.timeInState += dt; }
}

StateManager.BOOT = 'STATE_BOOT';
StateManager.ATTRACT = 'STATE_ATTRACT';
StateManager.MINING = 'STATE_MINING';
StateManager.AWAKE = 'STATE_AWAKE';
StateManager.GAMEOVER = 'STATE_GAMEOVER';

StateManager.TRANSITIONS = {
    STATE_BOOT: ['STATE_ATTRACT'],
    STATE_ATTRACT: ['STATE_MINING'],
    STATE_MINING: ['STATE_AWAKE', 'STATE_GAMEOVER', 'STATE_ATTRACT'],
    STATE_AWAKE: ['STATE_MINING', 'STATE_GAMEOVER', 'STATE_ATTRACT'],
    STATE_GAMEOVER: ['STATE_ATTRACT', 'STATE_MINING']
};

if (typeof module !== 'undefined') module.exports = { StateManager };
