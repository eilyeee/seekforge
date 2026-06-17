export function withdraw(account, amount) {
  return { ...account, balance: account.balance - amount };
}
