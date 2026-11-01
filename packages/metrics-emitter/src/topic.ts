import { Kafka } from "kafkajs";

/**
 * Create the metrics topic with the intended partition count if it does not
 * exist. Broker auto-create would give a single partition, which caps the
 * aggregator at one consumer; we want room to scale it horizontally.
 */
export async function ensureTopic(kafka: Kafka, topic: string, numPartitions: number): Promise<boolean> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    return await admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic,
          numPartitions,
          replicationFactor: 1,
          configEntries: [
            // Kafka only needs to hold what a lagging consumer might replay; 24h is generous.
            { name: "retention.ms", value: String(24 * 60 * 60 * 1000) },
            { name: "cleanup.policy", value: "delete" },
          ],
        },
      ],
    });
  } finally {
    await admin.disconnect();
  }
}
