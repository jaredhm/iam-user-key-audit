import {
  GetAccessKeyLastUsedCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListUsersCommand,
  ListUsersCommandOutput,
  StatusType,
  UpdateAccessKeyCommand,
} from "@aws-sdk/client-iam";
import { DateTimeFormatter, ZonedDateTime, nativeJs } from "@js-joda/core";
import { Locale } from "@js-joda/locale_en-us";
import "@js-joda/timezone";
import { confirm } from "@inquirer/prompts";

const client = new IAMClient({});
const formatter = DateTimeFormatter.ofPattern("MMMM d yyyy").withLocale(
  Locale.ENGLISH
);

const ONE_YEAR_AGO = ZonedDateTime.now().minusYears(1);

const run = async (destructiveMode: Boolean): Promise<void> => {
  const users = async function* () {
    let marker = undefined;
    do {
      const listUsersResult: ListUsersCommandOutput = await client.send(
        new ListUsersCommand({
          MaxItems: 10,
          Marker: marker,
        })
      );
      marker = listUsersResult.IsTruncated ? listUsersResult.Marker : null;
      for (const user of listUsersResult.Users ?? []) {
        const listAccessKeysResult = await client.send(
          new ListAccessKeysCommand({
            UserName: user.UserName,
          })
        );
        const promises = (listAccessKeysResult?.AccessKeyMetadata ?? []).map(
          async ({ AccessKeyId }) => {
            const getAccessKeyLastUsedResult = await client.send(
              new GetAccessKeyLastUsedCommand({
                AccessKeyId,
              })
            );
            return {
              AccessKeyId,
              AccessKeyLastUsed: getAccessKeyLastUsedResult.AccessKeyLastUsed,
            };
          }
        );
        const accessKeys = (await Promise.all(promises)).filter(
          <T>(v: T | undefined): v is T => Boolean(v)
        );
        yield {
          user,
          accessKeys,
        };
      }
    } while (marker);
  };
  if (destructiveMode) {
    console.log("Running in destructive mode");
    const shouldContinue = await confirm({ message: "Continue? " });
    if (!shouldContinue) {
      return;
    }
  }
  for await (const { user, accessKeys } of users()) {
    const sortedKeys = [...accessKeys];
    sortedKeys
      .sort((keyA, keyB) => {
        if (keyA.AccessKeyLastUsed?.LastUsedDate) {
          if (keyB.AccessKeyLastUsed?.LastUsedDate) {
            return (
              keyA.AccessKeyLastUsed.LastUsedDate.valueOf() -
              keyB.AccessKeyLastUsed.LastUsedDate.valueOf()
            );
          }
          return 1;
        }
        return keyB.AccessKeyLastUsed?.LastUsedDate ? -1 : 0;
      })
      .reverse();
    const lastUsedKey = sortedKeys[0];
    const lastUsedJoda = lastUsedKey.AccessKeyLastUsed?.LastUsedDate
      ? ZonedDateTime.from(nativeJs(lastUsedKey.AccessKeyLastUsed.LastUsedDate))
      : null;
    const keysAreStale = Boolean(
      lastUsedKey && (!lastUsedJoda || lastUsedJoda.isBefore(ONE_YEAR_AGO))
    );
    if (keysAreStale) {
      console.log(
        `${user.UserName} - Last used ${
          lastUsedJoda?.format(formatter) || "never"
        }`
      );
      if (destructiveMode) {
        console.log(`Disabling access keys for ${user.UserName}`);
        for (const key of accessKeys) {
          console.log(`- ${key.AccessKeyId}`);
          await client.send(
            new UpdateAccessKeyCommand({
              UserName: user.UserName,
              AccessKeyId: key.AccessKeyId,
              Status: StatusType.Inactive,
            })
          );
        }
      }
    }
  }
};

if (require.main === module) {
  run(process.argv.some((v) => /--destructive/.test(v)));
}
