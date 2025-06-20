import { WsConnection, WsServer } from "tsrpc";
import { gameConfig } from "../shared/game/gameConfig";
import { GameSystem, GameSystemInput, PlayerJoin } from "../shared/game/GameSystem";
import { ReqJoin } from "../shared/protocols/PtlJoin";
import { ServiceType } from "../shared/protocols/serviceProto";

/**
 * 服务端 - 房间 - 逻辑系统
 */
export class Room {

    // 帧同步频率，次数/秒
    syncRate = gameConfig.syncRate;
    nextPlayerId = 1;

    gameSystem = new GameSystem();

    server: WsServer<ServiceType>;
    conns: WsConnection<ServiceType>[] = [];
    pendingInputs: GameSystemInput[] = [];
    playerLastSn: { [playerId: number]: number | undefined } = {};
    lastSyncTime?: number;

    constructor (server: WsServer<ServiceType>) {
        this.server = server;
        setInterval(() => { this.onLogicFrameUpdate() }, 1000 / this.syncRate);
    }

    /** 加入房间 */
    join(req: ReqJoin, conn: WsConnection<ServiceType>) {
        let input: PlayerJoin = {
            type: 'PlayerJoin',
            playerId: this.nextPlayerId++,
            // 初始位置随机
            pos: {
                x: Math.random() * 10 - 5,
                y: Math.random() * 10 - 5
            }
        }
        //玩家加入时，初始化，将玩家位置添加pendingInputs中,等待下一帧发送
        this.addPendingInput(input);

        this.conns.push(conn);
        conn.playerId = input.playerId;
        //监听玩家输入
        conn.listenMsg('client/ClientInput', call => {
            this.playerLastSn[input.playerId] = call.msg.sn;
            //收到玩家输入，append到待处理输入列表
            call.msg.inputs.forEach(v => {
                this.addPendingInput({
                    ...v,
                    playerId: input.playerId
                });
            })
        });

        return input.playerId;
    }

    addPendingInput(input: GameSystemInput) {
        this.pendingInputs.push(input);
    }

    onLogicFrameUpdate() {
        // 获取收集到的输入
        let inputs = this.pendingInputs;
        // 清除 pendingInputs，为下一帧准备
        this.pendingInputs = [];
        // 将 pending 的输入应用到游戏系统
        inputs.forEach(v => {
            this.gameSystem.applyInput(v)
        });
        // 将这次frame的dt计算 然后添加到pending中
        let now = process.uptime() * 1000;
        this.addPendingInput({
            type: 'TimePast',
            dt: now - (this.lastSyncTime ?? now)
        });
        this.lastSyncTime = now;
        // 发送所有pendingInputs 到所有玩家
        this.conns.forEach(v => {
            v.sendMsg('server/Frame', {
                inputs: inputs,
                // 发送当前玩家的最后一条输入 SN
                lastSn: this.playerLastSn[v.playerId!]
            })
        });
    }

    /** 离开房间 */
    leave(playerId: number, conn: WsConnection<ServiceType>) {
        this.conns.removeOne(v => v.playerId === playerId);
        this.addPendingInput({
            type: 'PlayerLeave',
            playerId: playerId
        });
    }
}

declare module 'tsrpc' {
    export interface WsConnection {
        playerId?: number;
    }
}