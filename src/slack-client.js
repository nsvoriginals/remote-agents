export async function slackPost(client, channel, thread_ts, msg) {
  try {
    return await client.chat.postMessage({ channel, thread_ts, text: msg.text, blocks: msg.blocks });
  } catch (e) {
    if (!/block/i.test(e.data?.error || e.message)) throw e;
    return client.chat.postMessage({ channel, thread_ts, text: msg.text });
  }
}

export async function slackUpdate(client, channel, ts, msg) {
  try {
    return await client.chat.update({ channel, ts, text: msg.text, blocks: msg.blocks });
  } catch (e) {
    if (!/block/i.test(e.data?.error || e.message)) throw e;
    return client.chat.update({ channel, ts, text: msg.text, blocks: [] });
  }
}

export async function react(client, channel, timestamp, name, remove = false) {
  try {
    const fn = remove ? client.reactions.remove : client.reactions.add;
    await fn.call(client.reactions, { channel, timestamp, name });
  } catch {}
}