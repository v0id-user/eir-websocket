defmodule Eir.ID do
  @moduledoc """
  UUIDv7 generator. Time-ordered 128-bit IDs — same ID in cache, DB, and wire.
  Sorts lexicographically by creation time, so cursor pagination uses `id DESC`.

  Format (RFC 9562):
    bits 0..47   unix ms
    bits 48..51  version (7)
    bits 52..63  rand_a (12 bits)
    bits 64..65  variant (10)
    bits 66..127 rand_b (62 bits)
  """

  @doc "Returns a UUIDv7 as a 36-char string."
  def generate, do: generate_bin() |> bin_to_string()

  @doc "Returns a UUIDv7 as a 16-byte binary (Ecto :binary_id)."
  def generate_bin do
    ms = System.system_time(:millisecond)
    <<rand_a::12, rand_b::62, _::6>> = :crypto.strong_rand_bytes(10)
    <<ms::unsigned-big-48, 7::4, rand_a::12, 2::2, rand_b::62>>
  end

  @doc "Convert a 36-char UUID string to 16-byte binary."
  def string_to_bin(<<_::binary-size(36)>> = s) do
    s
    |> String.replace("-", "")
    |> Base.decode16!(case: :mixed)
  end

  @doc "Convert a 16-byte binary UUID to canonical lowercase string."
  def bin_to_string(<<a::32, b::16, c::16, d::16, e::48>>) do
    [hex(a, 8), "-", hex(b, 4), "-", hex(c, 4), "-", hex(d, 4), "-", hex(e, 12)]
    |> IO.iodata_to_binary()
  end

  @doc "Extract the unix-ms timestamp embedded in a UUIDv7."
  def timestamp_ms(<<ms::unsigned-big-48, _::80>>), do: ms
  def timestamp_ms(<<_::binary-size(36)>> = s), do: s |> string_to_bin() |> timestamp_ms()

  defp hex(int, pad) do
    int
    |> Integer.to_string(16)
    |> String.downcase()
    |> String.pad_leading(pad, "0")
  end
end
