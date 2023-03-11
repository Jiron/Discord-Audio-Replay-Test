import { PassThrough, pipeline, Readable, Transform, TransformCallback, Writable } from 'node:stream';
import { createWriteStream } from 'fs';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { joinVoiceChannel, EndBehaviorType, StreamType, createAudioPlayer, createAudioResource, NoSubscriberBehavior, VoiceConnection, VoiceReceiver } from "@discordjs/voice";
import { config as configDotEnv } from "dotenv";
import { Mixer, MixerArguments } from 'audio-mixer';
import DiscordOpus from '@discordjs/opus';

configDotEnv();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
});

client.on("ready", () => {
  console.log(`the bot is online!`);
});

let connection: VoiceConnection | undefined = undefined;

const speakingUsers = new Set<string>();

client.on("messageCreate", (message) => {
  // if(message.author.id != "501819491764666386") return;

  const { guild, member, channel } = message;

  if (!guild) {
    return;
  }

  if (!member) {
    return;
  }

  if (channel.type !== ChannelType.GuildText) {
    return;
  }

  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    return;
  }

  if (message.content !== '!join') {
    return;
  }

  if (connection && connection.joinConfig.channelId !== voiceChannel.id) {
    connection.destroy();
  }

  connection = patchVoiceConnection(joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  }));

  const mixer = new Mixer(
    {
      channels: 2,
      bitDepth: 16,
      sampleRate: 48000,
      clearInterval: 250
    } as MixerArguments
  );

  const mixerOutput = pipeline(
    mixer,
    new DumpStream(createWriteStream('mixed.pcm')),
    () => void 0
  )

  const audioPlayer = createAudioPlayer({
    behaviors: {
      maxMissedFrames: 1000,
      noSubscriber: NoSubscriberBehavior.Play
    }
  });

  const { receiver } = connection;

  const play = (userId: string) => mixStream(userId, receiver, mixer);

  speakingUsers.clear();
  Array.from(receiver.speaking.users.keys()).map(play);
  receiver.speaking.on("start", play);

  audioPlayer.play(createAudioResource(mixerOutput, { inputType: StreamType.Raw }));
  connection.subscribe(audioPlayer);
});

function mixStream(userId: string, receiver: VoiceReceiver, mixer: Mixer) {
  if (speakingUsers.has(userId)) {
    return;
  }

  speakingUsers.add(userId);

  const receiverStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 100 } });

  // input pipeline
  const input = pipeline(
    receiverStream,
    new OpusDecoderStream(new DiscordOpus.OpusEncoder(48000, 2)),
    new DumpStream(createWriteStream(`user-${userId}.pcm`)),
    new BufferedStream(2),
    mixer.input({ volume: 75 }),
    () => void 0
  );

  receiverStream.once("end", () => {
    receiverStream.destroy();
    mixer.removeInput(input);
    speakingUsers.delete(userId);
  });
}

client.login(process.env.TOKEN);

const networkStateChangeHandler = (oldNetworkState: any, newNetworkState: any) => {
  const newUdp = Reflect.get(newNetworkState, 'udp');
  clearInterval(newUdp?.keepAliveInterval);
}

function patchVoiceConnection(connection: VoiceConnection): VoiceConnection {
  connection.on('stateChange', (oldState, newState) => {
    const oldNetworking = Reflect.get(oldState, 'networking');
    const newNetworking = Reflect.get(newState, 'networking');

    oldNetworking?.off('stateChange', networkStateChangeHandler);
    newNetworking?.on('stateChange', networkStateChangeHandler);
  });

  return connection;
}

class OpusDecoderStream extends Transform {
  constructor(private opus: DiscordOpus.OpusEncoder) {
    super({
      writableObjectMode: true,
      readableObjectMode: false
    });
  }

  _transform(opusPacket: Buffer, encoding: BufferEncoding, done: TransformCallback) {
    this.push(this.opus.decode(opusPacket));
    done();
  }
}

class BufferedStream extends Transform {
  private blocks: Buffer[] = [];

  constructor(private numBlocks: number) {
    super();
  }

  _transform(pcm: Buffer, encoding: BufferEncoding, done: TransformCallback) {
    this.blocks.push(pcm);

    while (this.blocks.length && this.blocks.length >= this.numBlocks) {
      this.push(this.blocks.shift());
    }

    done();
  }
}

class DumpStream extends Transform {
  constructor(private dumpTo: Writable) {
    super();
  }

  _transform(pcm: Buffer, encoding: BufferEncoding, done: TransformCallback) {
    this.push(pcm);
    this.dumpTo.write(pcm);
    done();
  }
}
