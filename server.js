const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

// Complete global tracking states
let clientRegistry = {}; // socket.id -> { username: string, currentRoom: string, role: string }
let matchmakingQueue = []; // Array of socket IDs waiting for a random match
let matches = {}; // matchId -> detailed game state object

function generateMatchId() {
    return 'match_' + Math.random().toString(36).substr(2, 9);
}

function initializeNewMatch(matchId, p1Id, p2Id) {
    matches[matchId] = {
        id: matchId,
        p1: { id: p1Id, name: clientRegistry[p1Id].username },
        p2: { id: p2Id, name: clientRegistry[p2Id].username },
        status: 'toss', // toss, toss-throw, decision, playing, gameover
        tossChoice: '', // 'odd' or 'even'
        tossMoves: { p1: null, p2: null },
        battingPlayer: 'p1', // 'p1' or 'p2'
        bowlingPlayer: 'p2', // 'p1' or 'p2'
        target: null,
        score: 0,
        innings: 1,
        currentMoves: { p1: null, p2: null },
        lastBatNum: '-',
        lastBowlNum: '-',
        lastActionText: 'Players matched randomly! Player 1, make the Toss Selection (Odd or Even).',
        winnerRole: null, // 'p1', 'p2', or 'tie'
        outcomeReason: ''
    };

    // Update client registry data
    clientRegistry[p1Id].currentRoom = matchId;
    clientRegistry[p1Id].role = 'p1';
    clientRegistry[p2Id].currentRoom = matchId;
    clientRegistry[p2Id].role = 'p2';
}

function broadcastMatchState(matchId) {
    if (!matches[matchId]) return;
    io.to(matchId).emit('sync-lobby', matches[matchId]);
}

function broadcastLobbyData() {
    // Collect active matches metadata for spectators to read
    let activeMatchesList = Object.values(matches).map(m => ({
        id: m.id,
        p1Name: m.p1.name,
        p2Name: m.p2.name,
        status: m.status,
        score: m.score,
        innings: m.innings
    }));

    io.emit('lobby-update', {
        queueCount: matchmakingQueue.length,
        activeMatches: activeMatchesList
    });
}

io.on('connection', (socket) => {
    // Assign a temporary unique username upon landing
    const randomTag = 'User_' + socket.id.substr(0, 5);
    clientRegistry[socket.id] = { username: randomTag, currentRoom: 'lobby', role: 'spectator' };
    
    // Put them into the global base lobby room first
    socket.join('lobby');
    socket.emit('identity-confirmed', { username: randomTag, role: 'spectator' });
    broadcastLobbyData();

    // 1. Name configuration update
    socket.on('set-username', (newName) => {
        if (!newName || newName.trim() === "") return;
        clientRegistry[socket.id].username = newName.trim();
        
        // Update live matches if they are already in one
        const room = clientRegistry[socket.id].currentRoom;
        if (room !== 'lobby' && matches[room]) {
            if (matches[room].p1.id === socket.id) matches[room].p1.name = newName;
            if (matches[room].p2.id === socket.id) matches[room].p2.name = newName;
            broadcastMatchState(room);
        }
        
        socket.emit('identity-confirmed', { 
            username: clientRegistry[socket.id].username, 
            role: clientRegistry[socket.id].role 
        });
        broadcastLobbyData();
    });

    // 2. Random Matchmaking system
    socket.on('join-matchmaking', () => {
        if (clientRegistry[socket.id].currentRoom !== 'lobby') return;
        if (matchmakingQueue.includes(socket.id)) return;

        matchmakingQueue.push(socket.id);
        socket.emit('matchmaking-status', 'searching');
        console.log(`Queue updated. Total waiting: ${matchmakingQueue.length}`);

        // Match pairs off whenever 2 slots fill up
        if (matchmakingQueue.length >= 2) {
            const p1Id = matchmakingQueue.shift();
            const p2Id = matchmakingQueue.shift();

            const matchId = generateMatchId();
            
            // Move both from lobby stream into structural game streams
            io.sockets.sockets.get(p1Id)?.leave('lobby');
            io.sockets.sockets.get(p2Id)?.leave('lobby');
            io.sockets.sockets.get(p1Id)?.join(matchId);
            io.sockets.sockets.get(p2Id)?.join(matchId);

            initializeNewMatch(matchId, p1Id, p2Id);

            io.to(p1Id).emit('identity-confirmed', { username: clientRegistry[p1Id].username, role: 'p1' });
            io.to(p2Id).emit('identity-confirmed', { username: clientRegistry[p2Id].username, role: 'p2' });
            
            broadcastMatchState(matchId);
        }
        broadcastLobbyData();
    });

    // 3. Selective Spectator Channel Routing
    socket.on('spectate-match', (matchId) => {
        if (!matches[matchId]) return;

        // Clean up legacy room routing bindings safely
        const oldRoom = clientRegistry[socket.id].currentRoom;
        socket.leave(oldRoom);

        socket.join(matchId);
        clientRegistry[socket.id].currentRoom = matchId;
        clientRegistry[socket.id].role = 'spectator';

        socket.emit('identity-confirmed', { username: clientRegistry[socket.id].username, role: 'spectator' });
        socket.emit('sync-lobby', matches[matchId]);
    });

    // 4. Return to main lobby station
    socket.on('leave-match', () => {
        const room = clientRegistry[socket.id].currentRoom;
        if (room === 'lobby') return;

        socket.leave(room);
        socket.join('lobby');

        // Handle structural teardown if an active competitive player forfeits/leaves
        if (matches[room] && (clientRegistry[socket.id].role === 'p1' || clientRegistry[socket.id].role === 'p2')) {
            io.to(room).emit('room-collapsed', 'A core player abandoned the match pitch. Room closing...');
            
            // Re-route all spectators back to lobby smoothly
            io.in(room).socketsLeave(room);
            io.in(room).socketsJoin('lobby');
            delete matches[room];
        }

        clientRegistry[socket.id].currentRoom = 'lobby';
        clientRegistry[socket.id].role = 'spectator';

        socket.emit('identity-confirmed', { username: clientRegistry[socket.id].username, role: 'spectator' });
        broadcastLobbyData();
    });

    // 5. Traditional Gameplay Core Logic Loops (Scoped via Room parameter targets)
    socket.on('toss-choice', (choice) => {
        const room = clientRegistry[socket.id].currentRoom;
        const match = matches[room];
        if (!match || match.status !== 'toss') return;

        if (socket.id === match.p1.id) {
            match.tossChoice = choice;
            match.status = 'toss-throw';
            match.lastActionText = `${match.p1.name} chose ${choice.toUpperCase()}. Both players, enter a number (1-10) for the toss throw!`;
            broadcastMatchState(room);
        }
    });

    socket.on('submit-number', (num) => {
        if (num < 1 || num > 10) return;
        const room = clientRegistry[socket.id].currentRoom;
        const match = matches[room];
        if (!match) return;

        const pRole = clientRegistry[socket.id].role; // 'p1' or 'p2'
        if (pRole === 'spectator') return;

        if (match.status === 'toss-throw') {
            match.tossMoves[pRole] = num;

            if (match.tossMoves.p1 !== null && match.tossMoves.p2 !== null) {
                const sum = match.tossMoves.p1 + match.tossMoves.p2;
                const isSumOdd = sum % 2 !== 0;
                const p1Won = (match.tossChoice === 'odd' && isSumOdd) || (match.tossChoice === 'even' && !isSumOdd);
                
                match.status = 'decision';
                const winnerName = p1Won ? match.p1.name : match.p2.name;
                match.lastActionText = `Toss Results: ${match.tossMoves.p1} + ${match.tossMoves.p2} = ${sum} (${isSumOdd ? 'ODD' : 'EVEN'}). ${winnerName} Wins the Toss!`;
            } else {
                match.lastActionText = `${clientRegistry[socket.id].username} threw down. Waiting for opponent...`;
            }
            broadcastMatchState(room);
        } 
        else if (match.status === 'playing') {
            match.currentMoves[pRole] = num;

            if (match.currentMoves.p1 !== null && match.currentMoves.p2 !== null) {
                const batNum = match.battingPlayer === 'p1' ? match.currentMoves.p1 : match.currentMoves.p2;
                const bowlNum = match.bowlingPlayer === 'p1' ? match.currentMoves.p1 : match.currentMoves.p2;
                
                match.lastBatNum = batNum;
                match.lastBowlNum = bowlNum;

                const batterName = match[match.battingPlayer].name;
                const bowlerName = match[match.bowlingPlayer].name;

                if (batNum === bowlNum) {
                    if (match.innings === 1) {
                        match.target = match.score + 1;
                        match.lastActionText = `💥 OUT! ${batterName} matched ${batNum}. Target set to ${match.target}. Commencing Innings 2!`;
                        
                        // Swap Roles systematically
                        const oldBatter = match.battingPlayer;
                        match.battingPlayer = match.bowlingPlayer;
                        match.bowlingPlayer = oldBatter;
                        
                        match.score = 0;
                        match.innings = 2;
                    } else {
                        match.status = 'gameover';
                        if (match.score === match.target - 1) {
                            match.outcomeReason = "tie";
                            match.winnerRole = "tie";
                            match.lastActionText = "🏁 MATCH OVER: It's a precise TIE!";
                        } else {
                            match.outcomeReason = "defended";
                            match.winnerRole = match.bowlingPlayer;
                            match.lastActionText = `🏁 MATCH OVER: ${bowlerName} successfully defended the total target!`;
                        }
                    }
                } else {
                    match.score += batNum;
                    match.lastActionText = `${batterName} scores +${batNum} runs safely.`;

                    if (match.innings === 2 && match.score >= match.target) {
                        match.status = 'gameover';
                        match.outcomeReason = "chased";
                        match.winnerRole = match.battingPlayer;
                        match.lastActionText = `🏁 MATCH OVER: ${match[match.battingPlayer].name} successfully chased the target!`;
                    }
                }
                match.currentMoves = { p1: null, p2: null };
            } else {
                match.lastActionText = `${clientRegistry[socket.id].username} logged value. Awaiting opponent selection...`;
            }
            broadcastMatchState(room);
        }
    });

    socket.on('toss-decision', (decision) => {
        const room = clientRegistry[socket.id].currentRoom;
        const match = matches[room];
        if (!match || match.status !== 'decision') return;

        const p1WonToss = match.lastActionText.includes(match.p1.name);
        const choiceOwnerId = p1WonToss ? match.p1.id : match.p2.id;

        if (socket.id === choiceOwnerId) {
            const decisionMakerRole = p1WonToss ? 'p1' : 'p2';
            const opponentRole = p1WonToss ? 'p2' : 'p1';

            if (decision === 'bat') {
                match.battingPlayer = decisionMakerRole;
                match.bowlingPlayer = opponentRole;
            } else {
                match.bowlingPlayer = decisionMakerRole;
                match.battingPlayer = opponentRole;
            }
            match.status = 'playing';
            match.lastActionText = `Match Started! ${match[match.battingPlayer].name} is Batting, ${match[match.bowlingPlayer].name} is Bowling.`;
            broadcastMatchState(room);
        }
    });

    socket.on('force-restart', () => {
        const room = clientRegistry[socket.id].currentRoom;
        const match = matches[room];
        if (!match || clientRegistry[socket.id].role === 'spectator') return;

        // Re-initialize this exact targeted room structure map safely
        match.status = 'toss';
        match.tossChoice = '';
        match.tossMoves = { p1: null, p2: null };
        match.battingPlayer = 'p1';
        match.bowlingPlayer = 'p2';
        match.target = null;
        match.score = 0;
        match.innings = 1;
        match.currentMoves = { p1: null, p2: null };
        match.lastBatNum = '-';
        match.lastBowlNum = '-';
        match.lastActionText = "Arena manually reset! Player 1, make the Toss Selection.";
        match.winnerRole = null;
        match.outcomeReason = '';

        broadcastMatchState(room);
    });

    // 6. Hard cleanups on close/kill switches
    socket.on('disconnect', () => {
        const room = clientRegistry[socket.id].currentRoom;
        const role = clientRegistry[socket.id].role;

        // Strip out of matchmaking queues
        matchmakingQueue = matchmakingQueue.filter(id => id !== socket.id);

        if (room !== 'lobby' && matches[room]) {
            if (role === 'p1' || role === 'p2') {
                io.to(room).emit('room-collapsed', 'A core player disconnected. Match abandoned.');
                delete matches[room];
            }
        }

        delete clientRegistry[socket.id];
        broadcastLobbyData();
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Grand Stand Cluster running on port ${PORT}`);
});
