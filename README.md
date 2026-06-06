# Handcricketonline
https://handcricketonline.onrender.com/
#  Multi-Player Hand Cricket Arena

A real-time, 2-player multiplayer Hand Cricket game built using **Node.js, Express, and Socket.IO**. This repository transforms the traditional childhood game into a robust, web-based digital arena featuring a **Deterministic Unified State Machine** to prevent desynchronization, layout collapse, or stale player identity drops during matches.

---

## Features

- **True 2-Player Match Sync:** Both screens update simultaneously using an atomic server-to-client broadcast architecture (`sync-lobby`).
- **Dynamic Connection & Role Guard:** Rigid slots map clients directly to `Player 1` and `Player 2` indexes, making the room resilient against unexpected browser page refreshes or connection switches.
- **Complete In-Game Rules Enforcement:** Includes a structured initialization sequence covering Odd/Even Selection, Toss Throw totals evaluation, Decision Selection (Bat or Bowl first), and an alternating 2-Innings system.
- **Comprehensive Post-Match Logic:** Visualized victory cards dynamically outputting exact statuses (`Victory`, `Defeat`, or `Match Tied`) based on individual client roles.
- **Manual & Auto Fallback Reset Routines:** Equipped with an instantaneous manual reset button along with an automated 30-second rollback fallback counter to cleanly recycle rooms.
- **Premium Dark UI Design:** Modern stadium dashboard styling built with crisp custom CSS variables (`:root` tokens) and a mobile-responsive button layout.

---

## Repository Architecture & File Structure

The project maintains a lightweight, flat, and highly modular structure containing:

```text
├── server.js          # Unified State Machine, Express server, and Socket.IO connection event loop
├── index.html         # Responsive frontend layout, CSS variables, and dynamic DOM rendering layer
├── package.json       # Node environment properties and project script requirements
└── README.md          # Project instructions and documentation handbook (This File)
